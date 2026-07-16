/**
 * production-manifest-routing.test.ts — regression for the 2026-07-15 03:39 sync
 * (run 134cd9bd) MC-attachment drop.
 *
 * THE BUG: the Mail Clerk keys MC's "Daily Production Report" under the manifest key
 * `production_mc` (mailClerk.ts::mailQueries — the canonical Storage sub-key the app's
 * investigator also knows, lib/investigator/source.ts::SOURCE_KEYS). But the production
 * report layer READ the wrong key `production` (reportWorkflow.ts slice +
 * reports/production/index.ts::runReport firstAttachment). So a downloaded MC workbook
 * NEVER reached the production step: firstAttachment(manifest,"production") returned null,
 * and with the waste side also absent (already processed), runReport short-circuited to
 * "Nothing new today — no production or waste report waiting." → 07-14 production/
 * electricity silently never ingested.
 *
 * This test drives runReport with a manifest keyed EXACTLY as the Mail Clerk keys it
 * (`production_mc`, waste absent — the 07-14 situation) over the real 3Q fixture. With
 * the pre-fix reader it hits the empty short-circuit (per_section all 0, "Nothing new"
 * beat) — RED. With the reader aligned to `production_mc` the MC workbook is extracted
 * and classified (per_section.runs > 0, no "Nothing new" beat) — GREEN.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";

import { runReport, type ProductionManifest } from "../../src/reports/production/index.js";
import type { DbClient, Row, InsertIfAbsentResult } from "../../src/lib/db.js";

const FX = join(__dirname, "../../fixtures/production/workbooks");
const MC_FIXTURE = join(FX, "production_mc_3q.xlsx");

/** The manifest key the Mail Clerk actually emits for MC (mailQueries() + SOURCE_KEYS). */
const MAIL_CLERK_MC_KEY = "production_mc";

function okInsert(row: Row): InsertIfAbsentResult {
  const inserted = { ...row, id: `NEW-${Math.random().toString(36).slice(2, 8)}` };
  return { inserted: [inserted], skipped: [], insertedCount: 1, skippedCount: 0 };
}

/** Empty-DB mock: no existing shifts/children/readings; every insert succeeds. */
function mockDb(): DbClient {
  const stub: Partial<DbClient> = {
    productionRunsFrontier: async () => "2026-06-25",
    readRows: async () => [],
    insertIfAbsent: async (_table: string, rows: Row[]) => okInsert(rows[0]),
    update: async () => [],
    selectOne: async () => null,
    writeIngestionAudit: async () => ({ id: "AUDIT-1" }),
    upsertIngestionWatermark: async () => true,
  };
  return stub as DbClient;
}

describe("production manifest routing — MC attachment must reach the production step (07-15 regression)", () => {
  it("routes the Mail-Clerk-keyed MC workbook into runReport (waste absent — the 07-14 case)", async () => {
    const events: { stage: string; label: string }[] = [];

    // Manifest EXACTLY as the Mail Clerk builds it: MC under `production_mc`, no waste.
    const manifest: ProductionManifest = {
      reports: {
        [MAIL_CLERK_MC_KEY]: [
          {
            storagePath: `run/${MAIL_CLERK_MC_KEY}/Daily Production Report 2026 3Q.xlsx`,
            filename: "Daily Production Report 2026 3Q.xlsx",
            emailUid: 999,
            emailSubject: "Re: Daily Production Report",
            threadId: "t-mc",
          },
        ],
        production_waste: [], // Ivy's waste already processed this run → absent.
      },
    };

    const result = await runReport(
      {
        db: mockDb(),
        fetchToLocalPath: async () => MC_FIXTURE,
        labeler: async () => true,
        noLabel: true,
        progress: async (stage, label) => {
          events.push({ stage, label });
        },
        runTs: "2026-07-15T03:39:00.000Z",
      },
      "run",
      manifest,
      { since: "2026-06-25" },
    );

    // The MC workbook was found and classified — NOT the empty short-circuit.
    const nothingNew = events.some((e) => /Nothing new today/i.test(e.label));
    expect(nothingNew).toBe(false);
    // per_section.runs > 0 proves MC's runs were extracted + classified (would be 0 if
    // the MC attachment had been dropped by the manifest-key mismatch).
    expect(result.classify.per_section.runs).toBeGreaterThan(0);
    // Electricity + trucks (MC-only sections) also flow through — the 07-14 casualty.
    expect(result.classify.per_section.electricity).toBeGreaterThan(0);
    expect(result.classify.per_section.trucks).toBeGreaterThan(0);
  });
});
