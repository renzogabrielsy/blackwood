/**
 * db.test.ts — regression coverage for `DbClient.insertSettlements` (2026-07-13 bug fix).
 *
 * BUG: `insertSettlements` used to delegate to `insertIfAbsent`, which hardcodes
 * `selectOne(table, filters, "id")` — a `.select("id")` PostgREST call. But
 * `rc_out_date_settlements` has NO `id` column (its PK is `transaction_date`), so every
 * pre-insert check threw "column rc_out_date_settlements.id does not exist", the error
 * was swallowed by insertSettlements' own try/catch, and the method silently returned
 * `{insertedCount: 0, ...}` forever — while `runSync.ts::persistSettlements` logged
 * "Settled N new date(s)" using the COMPUTED count, not the actual write result. Net:
 * the whole ledger never persisted a single row.
 *
 * These tests exercise the REAL `insertSettlements` implementation against a mocked
 * `this.sb` (the Supabase query-builder) shaped like the actual `rc_out_date_settlements`
 * table — i.e. with no `id` column ever referenced. They fail against the old
 * `insertIfAbsent`-based implementation because that code path never calls
 * `.from(table).upsert(...)` at all (it calls `.from(table).select(...)` for the
 * pre-check), so against a mock that only implements the upsert-chain shape, the old
 * code throws inside the try/catch and returns `{insertedCount: 0, skippedCount: rows.length}`
 * for EVERY row — which fails the "partial settlement" assertion below (2 inserted, 1
 * skipped) since old code always reports 0 inserted.
 */
import { describe, it, expect } from "vitest";

import { DbClient, type DbConfig } from "../../src/lib/db.js";

const FAKE_CFG: DbConfig = { url: "http://localhost:54321", serviceRoleKey: "test-key" };

/** Minimal fake of the supabase-js query-builder chain used by insertSettlements:
 *  `this.sb.from(table).upsert(rows, opts).select(cols)` → Promise<{data, error}>.
 *  Simulates real `ignoreDuplicates: true` semantics: `.select()` after the upsert
 *  returns ONLY the rows that were newly inserted (rows whose transaction_date is in
 *  `alreadyPresent` are silently dropped, matching PostgREST's ON CONFLICT DO NOTHING
 *  RETURNING behavior). Records every call for assertions.
 */
function makeFakeSb(opts: { alreadyPresent?: Set<string>; forceError?: { message: string; code: string } } = {}) {
  const alreadyPresent = opts.alreadyPresent ?? new Set<string>();
  const calls: {
    table: string | null;
    upsertRows: Array<Record<string, unknown>> | null;
    upsertOpts: Record<string, unknown> | null;
    selectCols: string | null;
  } = { table: null, upsertRows: null, upsertOpts: null, selectCols: null };

  const sb = {
    from(table: string) {
      calls.table = table;
      return {
        upsert(rows: Array<Record<string, unknown>>, upsertOpts: Record<string, unknown>) {
          calls.upsertRows = rows;
          calls.upsertOpts = upsertOpts;
          return {
            select(cols: string) {
              calls.selectCols = cols;
              if (opts.forceError) {
                return Promise.resolve({ data: null, error: opts.forceError });
              }
              const inserted = rows.filter(
                (r) => !alreadyPresent.has(String(r.transaction_date)),
              );
              return Promise.resolve({
                data: inserted.map((r) => ({ transaction_date: r.transaction_date })),
                error: null,
              });
            },
          };
        },
      };
    },
  };

  return { sb, calls };
}

describe("DbClient.insertSettlements — id-less table (rc_out_date_settlements)", () => {
  it("upserts on the transaction_date PK — never selects an 'id' column", async () => {
    const db = DbClient.fromEnv({
      SUPABASE_URL: FAKE_CFG.url,
      SUPABASE_SERVICE_ROLE_KEY: FAKE_CFG.serviceRoleKey,
    } as unknown as NodeJS.ProcessEnv);
    const { sb, calls } = makeFakeSb();
    (db as unknown as { sb: unknown }).sb = sb;

    const rows = [
      { transaction_date: "2026-05-28", db_sum_kg: 56393, movement_kg: 56393 },
    ];
    const result = await db.insertSettlements(rows);

    expect(calls.table).toBe("rc_out_date_settlements");
    expect(calls.upsertOpts).toEqual({ onConflict: "transaction_date", ignoreDuplicates: true });
    expect(calls.selectCols).toBe("transaction_date");
    expect(calls.selectCols).not.toContain("id");
    expect(result).toEqual({ insertedCount: 1, skippedCount: 0 });
  });

  it("a partial re-run (some dates already settled) reports the ACTUAL inserted count, not the qualifying count", async () => {
    const db = DbClient.fromEnv({
      SUPABASE_URL: FAKE_CFG.url,
      SUPABASE_SERVICE_ROLE_KEY: FAKE_CFG.serviceRoleKey,
    } as unknown as NodeJS.ProcessEnv);
    const { sb } = makeFakeSb({ alreadyPresent: new Set(["2026-05-15"]) });
    (db as unknown as { sb: unknown }).sb = sb;

    const rows = [
      { transaction_date: "2026-05-15", db_sum_kg: 28087, movement_kg: 28087 }, // already settled
      { transaction_date: "2026-05-28", db_sum_kg: 56393, movement_kg: 56393 }, // new
      { transaction_date: "2026-06-01", db_sum_kg: 10050, movement_kg: 10000 }, // new
    ];
    const result = await db.insertSettlements(rows);

    // THE REGRESSION: old code (insertIfAbsent → select("id") on an id-less table)
    // always threw inside the per-row pre-check, was swallowed by the outer try/catch,
    // and returned {insertedCount: 0, skippedCount: rows.length} — i.e. {0, 3} here,
    // never distinguishing the 2 genuinely-new dates from the 1 already-settled one.
    expect(result).toEqual({ insertedCount: 2, skippedCount: 1 });
  });

  it("empty input short-circuits without touching sb at all", async () => {
    const db = DbClient.fromEnv({
      SUPABASE_URL: FAKE_CFG.url,
      SUPABASE_SERVICE_ROLE_KEY: FAKE_CFG.serviceRoleKey,
    } as unknown as NodeJS.ProcessEnv);
    let touched = false;
    (db as unknown as { sb: unknown }).sb = {
      from() {
        touched = true;
        throw new Error("sb.from should not be called for an empty rows array");
      },
    };

    const result = await db.insertSettlements([]);
    expect(result).toEqual({ insertedCount: 0, skippedCount: 0 });
    expect(touched).toBe(false);
  });

  it("stays best-effort/non-fatal: an upsert error returns zeros instead of throwing", async () => {
    const db = DbClient.fromEnv({
      SUPABASE_URL: FAKE_CFG.url,
      SUPABASE_SERVICE_ROLE_KEY: FAKE_CFG.serviceRoleKey,
    } as unknown as NodeJS.ProcessEnv);
    const { sb } = makeFakeSb({ forceError: { message: "connection reset", code: "500" } });
    (db as unknown as { sb: unknown }).sb = sb;

    const rows = [{ transaction_date: "2026-07-01", db_sum_kg: 1000, movement_kg: 1000 }];
    await expect(db.insertSettlements(rows)).resolves.toEqual({
      insertedCount: 0,
      skippedCount: 1,
    });
  });
});
