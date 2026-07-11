/**
 * batchAutoCreate.test.ts — unit tests for the sync's batch auto-create policy
 * (2026-07-11, src/lib/batchAutoCreate.ts). Locks:
 *   - the pattern-validity guard (the ENTIRE typo-safety net),
 *   - the template (mirrors lib/sync/create-batch-plan.ts::deriveBatchFields),
 *   - alias-of-existing resolution (no duplicate under a month-prefix alias),
 *   - the race-safe ensureBatch flow against a fake DbClient.
 */
import { describe, it, expect } from "vitest";

import {
  isPatternValidBatchCode,
  deriveBatchFields,
  resolveAgainstLookup,
  ensureBatch,
  autoCreateAuditComment,
  autoCreateMessage,
} from "../../src/lib/batchAutoCreate.js";
import type { DbClient } from "../../src/lib/db.js";

describe("isPatternValidBatchCode", () => {
  it("accepts real-shaped codes across month-prefix conventions + kinds", () => {
    for (const code of [
      "JULY-26-BLK6",
      "JUL-26-BLK6",
      "JANUARY-26-FEED1",
      "JAN-26-FEED1",
      "SEPT-25-SUNDRY2",
      "SEP-25-SUNDRY2",
      "SEPTEMBER-25-SUNDRY2",
      "MAY-26-BLK10",
      "december-25-blk7", // lowercase — case-insensitive
    ]) {
      expect(isPatternValidBatchCode(code), code).toBe(true);
    }
  });

  it("rejects typo'd / malformed codes (the safety guard)", () => {
    for (const code of [
      "JUALY-26-BLK6", // typo'd month
      "BLKZ", // no month/year structure at all
      "X",
      "JULY-26-BLK", // suffix has no number
      "JULY-266-BLK6", // year not 2 digits
      "JULY-26-6BLK", // digits before letters
      null,
      undefined,
      "",
      "   ",
    ]) {
      expect(isPatternValidBatchCode(code as string | null | undefined), String(code)).toBe(false);
    }
  });
});

describe("deriveBatchFields", () => {
  it("mirrors lib/sync/create-batch-plan.ts::deriveBatchFields exactly", () => {
    expect(deriveBatchFields("JULY-26-BLK6", "C-11A")).toEqual({
      batch_code: "JULY-26-BLK6",
      location_ref: "C-11A",
      status: "STORED",
      current_weight: 0,
      avg_cost: null,
    });
  });

  it("falls back to the FEED location_ref when block_loc is null/blank", () => {
    expect(deriveBatchFields("JULY-26-FEED1", null).location_ref).toBe("FEED");
    expect(deriveBatchFields("JULY-26-FEED1", "").location_ref).toBe("FEED");
    expect(deriveBatchFields("JULY-26-FEED1", "   ").location_ref).toBe("FEED");
  });
});

describe("resolveAgainstLookup", () => {
  it("resolves the primary code directly", () => {
    const lookup = { "JULY-26-BLK6": "id-1" };
    expect(resolveAgainstLookup("JULY-26-BLK6", lookup)).toEqual({
      batchId: "id-1",
      resolvedCode: "JULY-26-BLK6",
    });
  });

  it("resolves via a month-prefix fallback alias", () => {
    // JULY-26-BLK6's fallback set includes the uppercased form; JUL is NOT a fallback
    // of JULY (JULY has no alias — see MONTH_PREFIX_ALIASES), so use a month that DOES
    // alias both ways: MARCH <-> MAR.
    const lookup = { "MAR-26-BLK6": "id-2" };
    expect(resolveAgainstLookup("MARCH-26-BLK6", lookup)).toEqual({
      batchId: "id-2",
      resolvedCode: "MAR-26-BLK6",
    });
  });

  it("returns null when nothing in the lookup matches", () => {
    expect(resolveAgainstLookup("JULY-26-BLK6", {})).toBeNull();
    expect(resolveAgainstLookup(null, { "JULY-26-BLK6": "id-1" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ensureBatch — against a fake DbClient (only upsertBatchIfAbsent is exercised).
// ---------------------------------------------------------------------------

function fakeDb(behavior: {
  /** Simulates the DB's ON CONFLICT DO NOTHING outcome for upsertBatchIfAbsent. */
  alreadyExists?: Set<string>;
} = {}): { db: DbClient; inserted: Array<Record<string, unknown>> } {
  const alreadyExists = behavior.alreadyExists ?? new Set<string>();
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    async upsertBatchIfAbsent(row: Record<string, unknown>) {
      const code = String(row.batch_code);
      if (alreadyExists.has(code)) {
        return { id: `existing-${code}`, batch_code: code, created: false };
      }
      alreadyExists.add(code);
      inserted.push(row);
      return { id: `new-${code}`, batch_code: code, created: true };
    },
  };
  return { db: db as unknown as DbClient, inserted };
}

describe("ensureBatch", () => {
  it("(a) pattern-valid + genuinely new → creates via the template", async () => {
    const { db, inserted } = fakeDb();
    const lookup: Record<string, string> = {};
    const outcome = await ensureBatch(db, "JULY-26-BLK6", "C-11A", lookup);
    expect(outcome).toEqual({
      status: "created",
      batchId: "new-JULY-26-BLK6",
      resolvedCode: "JULY-26-BLK6",
      fields: {
        batch_code: "JULY-26-BLK6",
        location_ref: "C-11A",
        status: "STORED",
        current_weight: 0,
        avg_cost: null,
      },
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ batch_code: "JULY-26-BLK6", location_ref: "C-11A", avg_cost: null });
    // The lookup is seeded with every alias so a sibling row resolves for free.
    expect(lookup["JULY-26-BLK6"]).toBe("new-JULY-26-BLK6");
  });

  it("(b) pattern-invalid → invalid_pattern, no DB call, caller keeps the hold", async () => {
    const { db, inserted } = fakeDb();
    const lookup: Record<string, string> = {};
    const outcome = await ensureBatch(db, "BLKZ", "C-11A", lookup);
    expect(outcome).toEqual({ status: "invalid_pattern" });
    expect(inserted).toHaveLength(0);
    expect(lookup).toEqual({});
  });

  it("(c) alias-of-existing → resolves to the existing batch, never creates a duplicate", async () => {
    const { db, inserted } = fakeDb();
    // JULY-26-BLK6 already resolves via its month-prefix fallback (JULY has no
    // alias per MONTH_PREFIX_ALIASES; use MARCH/MAR, which DOES alias both ways).
    const lookup: Record<string, string> = { "MAR-26-BLK6": "existing-id" };
    const outcome = await ensureBatch(db, "MARCH-26-BLK6", "C-11A", lookup);
    expect(outcome).toEqual({
      status: "existing_alias",
      batchId: "existing-id",
      resolvedCode: "MAR-26-BLK6",
    });
    expect(inserted).toHaveLength(0); // no write at all
    expect(lookup["MARCH-26-BLK6"]).toBe("existing-id"); // seeded for next time
  });

  it("a second call in the same pass resolves via the in-memory lookup (no 2nd DB write)", async () => {
    const { db, inserted } = fakeDb();
    const lookup: Record<string, string> = {};
    const first = await ensureBatch(db, "JULY-26-BLK6", "C-11A", lookup);
    const second = await ensureBatch(db, "JULY-26-BLK6", "C-11A", lookup);
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing_alias");
    expect(inserted).toHaveLength(1);
  });

  it("a PARALLEL sibling lane race → race_lost_to_sibling, no duplicate audit", async () => {
    // Simulate the DB already having the row (as if a sibling writer lane created it
    // a moment earlier this same run) — our upsert hits ON CONFLICT DO NOTHING.
    const { db, inserted } = fakeDb({ alreadyExists: new Set(["JULY-26-BLK6"]) });
    const lookup: Record<string, string> = {}; // this lane's OWN stale lookup — misses it
    const outcome = await ensureBatch(db, "JULY-26-BLK6", "C-11A", lookup);
    expect(outcome.status).toBe("race_lost_to_sibling");
    if (outcome.status === "race_lost_to_sibling") {
      expect(outcome.batchId).toBe("existing-JULY-26-BLK6");
    }
    expect(inserted).toHaveLength(0); // upsertBatchIfAbsent did NOT insert (conflict)
  });

  it("no batch_code at all → invalid_pattern", async () => {
    const { db } = fakeDb();
    expect(await ensureBatch(db, null, "C-11A", {})).toEqual({ status: "invalid_pattern" });
    expect(await ensureBatch(db, undefined, "C-11A", {})).toEqual({ status: "invalid_pattern" });
  });
});

describe("audit + finding message builders", () => {
  it("autoCreateAuditComment names the source + run + row", () => {
    const c = autoCreateAuditComment({
      source: "gsheet (RC IN)",
      runTs: "2026-07-11T00:00:00.000Z",
      sourceRow: 1228,
    });
    expect(c).toContain("gsheet (RC IN)");
    expect(c).toContain("row 1228");
    expect(c).toContain("2026-07-11T00:00:00.000Z");
  });

  it("autoCreateMessage matches the spec's exact format", () => {
    const msg = autoCreateMessage({
      batchCode: "JULY-26-BLK6",
      locationRef: "C-11A",
      source: "Google Sheet RC IN",
      sourceRow: 1228,
    });
    expect(msg).toBe("Auto-created batch JULY-26-BLK6 (C-11A) from Google Sheet RC IN row 1228");
  });
});
