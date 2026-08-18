/**
 * deliveries-report-not-received.test.ts — the RUN WHERE NOTHING ARRIVED (2026-08-18, L-044).
 *
 * THE DEFECT. When no RC DELIVERIES attachment was waiting, `runReport` emitted
 *
 *     "Nothing new today — no RC DELIVERIES report waiting."   at 100% progress
 *
 * and returned an empty envelope. Two things were wrong with that, and each one on its own
 * is enough to hide an outage:
 *
 *   1. IT REASSURED. That sentence reads as *the sync checked, everything is fine*, and it
 *      was printed on the days RC IN was going stale. A run in which nothing arrived is
 *      otherwise indistinguishable from a quiet day — the absence of a signal is not a
 *      signal unless something says so.
 *   2. IT SKIPPED THE UNPRICED-OVERDUE CHECK. That check reads the DATABASE and has nothing
 *      to do with the mailbox; it exists precisely to catch a price outage "independent of
 *      why". It sat behind the early return, so it was gated on the very thing that had
 *      failed. Four truckloads crossed the overdue threshold on exactly the day the
 *      workbook stopped arriving, and the alarm was skipped on the first day it would have
 *      fired.
 *
 * A third failure is pinned here too: `readUnpricedOverdue` ended in `catch { return [] }`,
 * so a broken read and a genuinely clean database produced the same answer, and the run
 * would state "nothing overdue" on the strength of a question it never managed to ask.
 */
import { describe, it, expect } from "vitest";

import { runReport, type RunReportDeps } from "../../src/reports/deliveries/index.js";
import { flattenRunFindings } from "../../src/reports/excel/findingsBridge.js";
import { sidesForFinding } from "../../src/reports/excel/workbook.js";
import { normalizeApply } from "../../src/workflows/normalizeReport.js";
import type { AppSyncRunResult } from "../../src/reports/excel/findingsBridge.js";
import type { DbClient, Row } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// Scaffolding — the only DB reads this path makes.
// ---------------------------------------------------------------------------

interface StubOpts {
  /** `view_digest_stream_status` rows, or "throw" to model an unreadable view. */
  streamStatus?: Row[] | "throw";
  /** `view_digest_unpriced_deliveries` rows, or "throw" to model a broken read. */
  overdue?: Row[] | "throw";
}

function stubDb(opts: StubOpts = {}): DbClient {
  const stub: Partial<DbClient> = {
    dataWatermark: async () => "2026-08-14",
    readRows: async (table: string) => {
      if (table === "view_digest_stream_status") {
        if (opts.streamStatus === "throw") throw new Error("view unavailable");
        return opts.streamStatus ?? [];
      }
      if (table === "view_digest_unpriced_deliveries") {
        if (opts.overdue === "throw") throw new Error('column "days_pending" does not exist');
        return opts.overdue ?? [];
      }
      return [];
    },
  };
  return stub as DbClient;
}

/** The live stream-status row on the morning this was written (measured, not invented). */
function statusRow(missed: number): Row {
  return {
    stream: "deliveries",
    label: "RC In (deliveries)",
    reports_next_day: false,
    through_date: "2026-08-14",
    operational_date: "2026-08-17",
    missed_working_days: missed,
  };
}

function overdueRow(id: string, days: number): Row {
  return {
    id,
    transaction_date: "2026-08-14",
    supplier: "Ornales",
    batch_code: "AUGUST-26-BLK6",
    truck_plate: "MAV 9202",
    sacks: 520,
    weight_kg: 19_500,
    days_pending: days,
  };
}

/** An empty manifest — the "no RC DELIVERIES attachment" case. */
const NO_FILES = { reports: {} };

function deps(db: DbClient, beats: Array<{ label: string; level?: string }> = []): RunReportDeps {
  return {
    db,
    fetchToLocalPath: async () => {
      throw new Error("nothing should be fetched when no attachment arrived");
    },
    progress: (async (_stage, label, _pct, _detail, level) => {
      beats.push({ label: String(label), level: level as string | undefined });
    }) as RunReportDeps["progress"],
    noLabel: true,
    runTs: "2026-08-18T01:00:00Z",
  };
}

/** Wrap one deliveries report result the way `runSync` does, then fold it to findings. */
function findingsFor(apply: unknown) {
  const result = {
    reports: { deliveries: { classify: null, apply: normalizeApply("deliveries", apply as never) } },
  } as unknown as AppSyncRunResult;
  return flattenRunFindings(result);
}

// ---------------------------------------------------------------------------

describe("no RC DELIVERIES report arrived (L-044)", () => {
  it("raises a durable finding instead of reassuring at 100%", async () => {
    const beats: Array<{ label: string; level?: string }> = [];
    const res = await runReport(deps(stubDb({ streamStatus: [statusRow(1)] }), beats), "r", NO_FILES);

    // The old sentence is gone, and what replaced it is a warn, not an info.
    expect(beats.some((b) => /nothing new today/i.test(b.label))).toBe(false);
    const finalBeat = beats[beats.length - 1];
    expect(finalBeat.level).toBe("warn");

    // And it is DURABLE — it survives the run as a finding, not a progress beat.
    const note = res.apply.report_not_received;
    expect(note).toBeTruthy();
    expect(note!.report_type).toBe("deliveries");
    expect(note!.through_date).toBe("2026-08-14");
    expect(note!.missed_working_days).toBe(1);
    // Asia/Manila, not UTC: 01:00Z on the 18th is already the 18th at the plant.
    expect(note!.as_of).toBe("2026-08-18");

    const findings = findingsFor(res.apply);
    const f = findings.find((x) => x.kind === "report_not_received");
    expect(f).toBeTruthy();
    expect(f!.section).toBe("deliveries");
    expect(f!.severity).toBe("info"); // 1 missed working day — reported, not alarming
  });

  it("escalates on the VIEW'S number, and still fires at zero", async () => {
    const sev = async (missed: number) => {
      const res = await runReport(
        deps(stubDb({ streamStatus: [statusRow(missed)] })),
        "r",
        NO_FILES,
      );
      const f = findingsFor(res.apply).find((x) => x.kind === "report_not_received");
      expect(f, `missed=${missed} must still produce a finding`).toBeTruthy();
      return f!.severity;
    };
    // Zero still fires: that is the case where another writer (the Google Sheet) keeps the
    // data current while the email pipeline is quietly dead, and nothing else notices.
    expect(await sev(0)).toBe("info");
    expect(await sev(2)).toBe("attention");
    expect(await sev(4)).toBe("high");
  });

  it("reports the missing report even when the staleness view cannot be read", async () => {
    const res = await runReport(deps(stubDb({ streamStatus: "throw" })), "r", NO_FILES);
    const note = res.apply.report_not_received;
    expect(note).toBeTruthy();
    // NULL, never 0 — 0 means "measured, on time", and a guess must not impersonate a
    // measurement. And "we don't know" is not quieter than "we measured it and it is fine".
    expect(note!.missed_working_days).toBeNull();
    // …and it says WHICH kind of unknown. `unreadable` is the grant failure that blinded
    // the freshness watch for two weeks; it needs different words from "no such stream".
    expect(note!.lateness_unknown_reason).toBe("unreadable");
    const f = findingsFor(res.apply).find((x) => x.kind === "report_not_received");
    expect(f!.severity).toBe("attention");
  });

  it("distinguishes 'could not look' from 'no such stream'", async () => {
    // The view read fine and simply has no row for `deliveries` — a REGISTRY gap, not an
    // outage. Same null number, different cause, different fix.
    const res = await runReport(deps(stubDb({ streamStatus: [] })), "r", NO_FILES);
    const note = res.apply.report_not_received!;
    expect(note.missed_working_days).toBeNull();
    expect(note.lateness_unknown_reason).toBe("unregistered");
    // Both still report at `attention` — "we don't know" is never quieter than "we
    // measured it and it is fine" — but the operator is told which one this is.
    const f = findingsFor(res.apply).find((x) => x.kind === "report_not_received");
    expect(f!.severity).toBe("attention");
    expect(f!.data.lateness_unknown_reason).toBe("unregistered");
  });

  it("STILL runs the unpriced-overdue check — it reads the DB, not the mailbox", async () => {
    const res = await runReport(
      deps(stubDb({ streamStatus: [statusRow(1)], overdue: [overdueRow("d-1", 4), overdueRow("d-2", 4)] })),
      "r",
      NO_FILES,
    );
    // This is the check that was skipped on exactly the day it would have fired.
    expect(res.apply.unpriced_overdue).toHaveLength(2);
    const findings = findingsFor(res.apply);
    const overdue = findings.filter((f) => f.kind === "unpriced_overdue");
    expect(overdue).toHaveLength(2);
    expect(overdue[0].severity).toBe("high"); // 4 days pending
  });

  it("REPORTS a failed overdue read instead of claiming nothing is overdue", async () => {
    const res = await runReport(
      deps(stubDb({ streamStatus: [statusRow(1)], overdue: "throw" })),
      "r",
      NO_FILES,
    );
    expect(res.apply.unpriced_overdue).toEqual([]);
    const note = res.apply.price_notes.find((n) => n.kind === "price_overdue_check_failed");
    expect(note).toBeTruthy();
    expect(note!.detail).toContain("days_pending"); // the real failure, not a shrug
    const f = findingsFor(res.apply).find((x) => x.kind === "price_overdue_check_failed");
    expect(f!.severity).toBe("attention");
    expect(f!.title).toMatch(/cannot say/i);
  });

  it("still returns a clean, complete envelope — nothing is written, nothing fails", async () => {
    const res = await runReport(deps(stubDb({ streamStatus: [statusRow(1)] })), "r", NO_FILES);
    expect(res.classify.ok).toBe(true);
    expect(res.classify.counts).toEqual({ noop: 0, insert: 0, update: 0, flagged: 0 });
    expect(res.apply.ok).toBe(true);
    expect(res.apply.inserts).toBe(0);
    expect(res.apply.updates).toBe(0);
    expect(res.apply.held).toEqual([]);
    expect(res.apply.errors).toEqual([]);
    expect(res.apply.watermark_updated).toBe(false);
  });

  it("puts BOTH sides in the Excel report — what we have vs what day it is", async () => {
    const res = await runReport(deps(stubDb({ streamStatus: [statusRow(3)] })), "r", NO_FILES);
    const f = findingsFor(res.apply).find((x) => x.kind === "report_not_received")!;
    const sides = sidesForFinding(f as never);
    expect(sides.a).toContain("2026-08-14");
    expect(sides.b).toContain("2026-08-17");
  });

  it("never leaks a ₱ value through either new channel", async () => {
    const res = await runReport(
      deps(stubDb({ streamStatus: [statusRow(3)], overdue: [overdueRow("d-1", 6)] })),
      "r",
      NO_FILES,
    );
    for (const f of findingsFor(res.apply)) {
      for (const k of Object.keys(f.data)) {
        expect(/cost|price|php|peso/i.test(k), `cost-ish key in finding data: ${k}`).toBe(false);
      }
    }
  });
});
