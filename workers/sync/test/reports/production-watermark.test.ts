/**
 * production-watermark.test.ts — the MC RUNS-FRONTIER watermark fix.
 *
 * Bug: production_shifts is written by BOTH source reports — MC's DRIP Daily
 * Production Report (one day per email → runs/downtime/electricity/trucks) AND Ivy's
 * CUMULATIVE monthly WASTE workbook (parent-shift upsert creates a shift row for
 * EVERY waste day of the month). Because waste is cumulative it runs ahead of MC, so
 * MAX(production_shifts.transaction_date) tracks the latest WASTE day, not MC's
 * frontier. runReport fed that inflated max back as the EXCLUSIVE `since`, so extractMc
 * silently dropped every MC day-sheet dated <= it — MC's own streams stalled with no
 * error the moment waste passed MC's frontier.
 *
 * Fix: runReport now anchors `since` on db.productionRunsFrontier() = the max
 * production_shifts.transaction_date among shifts that HAVE a production_runs child
 * (production_runs is MC-only), mirroring the view_digest_stream_freshness production
 * branch. These tests lock:
 *   1. the accessor issues the inner-embed query and returns YYYY-MM-DD | null;
 *   2. runReport uses the RUNS frontier (lower) — not a waste-inflated shifts max — so
 *      MC day-sheets after the runs frontier are still extracted and classified NEW.
 *
 * The parity harness is UNAFFECTED: it calls classifyCase (frozen) with a FIXED
 * opts.since from the fixture manifest; the watermark derivation lives only in
 * runReport, which the harness never invokes.
 *
 * Ground truth: src/lib/db.ts::productionRunsFrontier, src/reports/production/index.ts,
 * supabase/migrations/20260714000000_digest_stream_freshness_production_output.sql.
 */
import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";

import { DbClient, type Row, type ReadRowsOptions, type InsertIfAbsentResult } from "../../src/lib/db.js";
import {
  runReport,
  type ProductionManifest,
  type RunReportDeps,
} from "../../src/reports/production/index.js";

const MC_FIXTURE = join(__dirname, "../../fixtures/production/workbooks/production_real_mc.xlsx");

// ---------------------------------------------------------------------------
// 1. The accessor itself — verify the exact PostgREST inner-embed query it issues
//    and the YYYY-MM-DD | null contract (identical to dataWatermark).
// ---------------------------------------------------------------------------
describe("db.productionRunsFrontier — MC runs-frontier accessor", () => {
  /** A chainable PostgREST stub that records the query shape and resolves to `data`. */
  function fakeSb(result: { data: unknown; error: unknown }) {
    const calls = { from: "", select: "", order: [] as Array<[string, boolean]>, limit: 0 };
    const builder: Record<string, unknown> = {
      select(sel: string) {
        calls.select = sel;
        return builder;
      },
      order(col: string, opts: { ascending: boolean }) {
        calls.order.push([col, opts.ascending]);
        return builder;
      },
      // The accessor awaits the result of .limit(1); await of a plain object returns it.
      limit(n: number) {
        calls.limit = n;
        return result;
      },
    };
    const sb = {
      from(table: string) {
        calls.from = table;
        return builder;
      },
    };
    return { sb, calls };
  }

  /** Build a DbClient bound to a fake sb without touching createClient. */
  function dbWith(sb: unknown): DbClient {
    const db = Object.create(DbClient.prototype) as DbClient;
    (db as unknown as { sb: unknown }).sb = sb;
    return db;
  }

  it("issues production_shifts?select=transaction_date,production_runs!inner(id) ordered desc, limit 1", async () => {
    const { sb, calls } = fakeSb({
      data: [{ transaction_date: "2026-07-03", production_runs: [{ id: "r1" }] }],
      error: null,
    });
    const out = await dbWith(sb).productionRunsFrontier();

    expect(out).toBe("2026-07-03");
    expect(calls.from).toBe("production_shifts");
    expect(calls.select).toBe("transaction_date,production_runs!inner(id)");
    expect(calls.order).toEqual([["transaction_date", false]]); // desc
    expect(calls.limit).toBe(1);
  });

  it("slices a timestamp value down to YYYY-MM-DD", async () => {
    const { sb } = fakeSb({
      data: [{ transaction_date: "2026-07-03T00:00:00+08:00", production_runs: [{ id: "r1" }] }],
      error: null,
    });
    expect(await dbWith(sb).productionRunsFrontier()).toBe("2026-07-03");
  });

  it("returns null when no shift has a run yet (empty result)", async () => {
    const { sb } = fakeSb({ data: [], error: null });
    expect(await dbWith(sb).productionRunsFrontier()).toBeNull();
  });

  it("throws on a PostgREST error (same style as dataWatermark)", async () => {
    const { sb } = fakeSb({ data: null, error: { code: "42P01", message: "boom" } });
    await expect(dbWith(sb).productionRunsFrontier()).rejects.toThrow(/production_runs_frontier failed/);
  });
});

// ---------------------------------------------------------------------------
// 2. runReport wiring — the waste-ahead regression. The real MC fixture has two
//    day-sheets: 07-01-26 and 07-02-26 (8 run rows total). Simulate the live DB where
//    Ivy's cumulative waste has shoved MAX(production_shifts.transaction_date) to
//    2026-07-02, while MC's real runs frontier sits at 2026-06-30.
// ---------------------------------------------------------------------------
describe("runReport — anchors `since` on the runs frontier, not the waste-inflated shifts max", () => {
  const manifest: ProductionManifest = {
    reports: {
      // MC only (no ivy) — isolates the MC-frontier → extraction path.
      production: [{ storagePath: "fake/mc.xlsx", filename: "DAILY.xlsx", emailUid: 1 }],
    },
  };

  /** Empty-DB stub: every read returns [], every write succeeds — so extracted MC runs
   *  classify NEW and apply completes. `productionRunsFrontier`/`dataWatermark` are the
   *  two dials under test. */
  function mkDb(frontier: string | null, shiftsMax: string | null) {
    const dataWatermark = vi.fn(async (_table: string) => shiftsMax);
    const productionRunsFrontier = vi.fn(async () => frontier);
    const db: Partial<DbClient> = {
      productionRunsFrontier,
      dataWatermark,
      readRows: async (_table: string, _opts: ReadRowsOptions = {}) => [] as Row[],
      insertIfAbsent: async (_table: string, rows: Row[]): Promise<InsertIfAbsentResult> => ({
        inserted: [{ ...rows[0], id: `id-${Math.random().toString(36).slice(2, 8)}` }],
        skipped: [],
        insertedCount: 1,
        skippedCount: 0,
      }),
      selectOne: async () => null,
      update: async () => [],
      writeIngestionAudit: async () => ({ id: "audit-1" }),
      upsertIngestionWatermark: async () => true,
    };
    return { db: db as DbClient, dataWatermark, productionRunsFrontier };
  }

  function deps(db: DbClient): RunReportDeps {
    return { db, fetchToLocalPath: async () => MC_FIXTURE, noLabel: true };
  }

  it("runs frontier 2026-06-30 (waste at 07-02) → both MC sheets extracted (8 runs), watermark = frontier", async () => {
    const { db, dataWatermark, productionRunsFrontier } = mkDb("2026-06-30", "2026-07-02");

    const result = await runReport(deps(db), "run-frontier", manifest);

    // Both day-sheets (07-01, 07-02) survived the EXCLUSIVE >2026-06-30 filter.
    expect(result.classify.per_section.runs).toBe(8);
    expect(result.classify.counts.insert).toBeGreaterThan(0);
    // The reported/used watermark is the RUNS frontier, NOT the waste-inflated shifts max.
    expect(result.classify.watermark).toBe("2026-06-30");
    // The fix reads the frontier and never falls back to the shifts-max watermark.
    expect(productionRunsFrontier).toHaveBeenCalledTimes(1);
    expect(dataWatermark).not.toHaveBeenCalled();
  });

  it("negative control: if the frontier were the waste-inflated 2026-07-02, every MC sheet is dropped (0 runs)", async () => {
    // This is exactly the BUGGY behavior the fix removes — proving the frontier VALUE is
    // what gates extraction. Feeding 2026-07-02 (the old shifts-max) drops 07-01 AND 07-02.
    const { db } = mkDb("2026-07-02", "2026-07-02");

    const result = await runReport(deps(db), "run-buggy", manifest);

    expect(result.classify.per_section.runs).toBe(0);
    expect(result.classify.counts.insert).toBe(0);
    expect(result.classify.watermark).toBe("2026-07-02");
  });

  it("opts.since still overrides the frontier (explicit since wins)", async () => {
    const { db, productionRunsFrontier } = mkDb("2026-06-30", "2026-07-02");

    // Explicit since=2026-07-01 → only the 07-02 sheet survives (4 runs).
    const result = await runReport(deps(db), "run-override", manifest, { since: "2026-07-01" });

    expect(result.classify.per_section.runs).toBe(4);
    // The accessor is still consulted for the returned watermark, but since overrides.
    expect(productionRunsFrontier).toHaveBeenCalledTimes(1);
  });
});
