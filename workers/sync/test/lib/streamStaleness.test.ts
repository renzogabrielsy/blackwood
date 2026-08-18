/**
 * streamStaleness.test.ts — the freshness watch (2026-08-04).
 *
 * Locks the ONE decision this module makes: which rows of `view_digest_stream_status`
 * become a run finding. Everything else — what counts as a working day, whether a
 * next-day stream is due yet — is the view's arithmetic and is deliberately NOT
 * re-implemented or re-tested here.
 *
 * The behaviour that matters most is the negative one: a quiet Sunday, and a next-day
 * stream that simply has not been written up yet, must NEVER raise a finding. An alert
 * that fires on normal days is an alert that gets ignored, which would put us straight
 * back to RC OUT going five days stale unnoticed.
 */
import { describe, it, expect } from "vitest";

import {
  selectStaleStreams,
  describeStaleStream,
  findStaleStreams,
  findStreamStatus,
  type StaleStream,
} from "../../src/lib/streamStaleness.js";
import type { DbClient, Row } from "../../src/lib/db.js";

function row(over: Partial<Row> = {}): Row {
  return {
    stream: "rc_out",
    label: "RC Out (usage)",
    reports_next_day: false,
    through_date: "2026-08-03",
    operational_date: "2026-08-03",
    missed_working_days: 0,
    ...over,
  } as Row;
}

describe("selectStaleStreams — what becomes a finding", () => {
  it("an up-to-date stream raises NOTHING", () => {
    expect(selectStaleStreams([row()])).toEqual([]);
  });

  it("the real 2026-08-04 board — all five current — is silent", () => {
    const live = [
      row({ stream: "deliveries", label: "RC In (deliveries)" }),
      row({ stream: "rc_out" }),
      row({ stream: "production", label: "Production" }),
      row({ stream: "electricity", label: "Electricity" }),
      // Trucks reported 08-01 but has missed no PLANNED day — the view already said so.
      row({ stream: "trucks", label: "Trucks", through_date: "2026-08-01", missed_working_days: 0 }),
    ];
    expect(selectStaleStreams(live)).toEqual([]);
  });

  it("one missed working day IS a finding", () => {
    const out = selectStaleStreams([row({ missed_working_days: 1, through_date: "2026-08-01" })]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ stream: "rc_out", missed_working_days: 1 });
  });

  it("sorts worst-first so the summary leads with the worst offender", () => {
    const out = selectStaleStreams([
      row({ stream: "trucks", label: "Trucks", missed_working_days: 1 }),
      row({ stream: "rc_out", missed_working_days: 5 }),
      row({ stream: "production", label: "Production", missed_working_days: 3 }),
    ]);
    expect(out.map((s) => s.stream)).toEqual(["rc_out", "production", "trucks"]);
  });

  it("ties break on stream name, so the order is stable run to run", () => {
    const out = selectStaleStreams([
      row({ stream: "trucks", label: "Trucks", missed_working_days: 2 }),
      row({ stream: "electricity", label: "Electricity", missed_working_days: 2 }),
    ]);
    expect(out.map((s) => s.stream)).toEqual(["electricity", "trucks"]);
  });

  it("a stream that has NEVER reported is a finding, not a crash", () => {
    const out = selectStaleStreams([row({ through_date: null, missed_working_days: 4 })]);
    expect(out).toHaveLength(1);
    expect(out[0].through_date).toBeNull();
    expect(describeStaleStream(out[0])).toContain("has never reported");
  });

  it("a missing/unparseable count is treated as NOT stale — silence beats crying wolf", () => {
    // If the view ever stops publishing the column, the watchdog goes quiet rather than
    // firing on every stream every run. A false alarm trains the operator to ignore it.
    expect(selectStaleStreams([row({ missed_working_days: null })])).toEqual([]);
    expect(selectStaleStreams([row({ missed_working_days: undefined })])).toEqual([]);
    expect(selectStaleStreams([row({ missed_working_days: "nonsense" })])).toEqual([]);
  });

  it("drops a row with no stream key", () => {
    expect(selectStaleStreams([row({ stream: "", missed_working_days: 9 })])).toEqual([]);
  });

  it("falls back to the stream key when the label is absent", () => {
    const out = selectStaleStreams([row({ label: null, missed_working_days: 1 })]);
    expect(out[0].label).toBe("rc_out");
  });
});

describe("describeStaleStream — the sentence the operator reads", () => {
  const base: StaleStream = {
    stream: "rc_out",
    label: "RC Out (usage)",
    through_date: "2026-07-29",
    operational_date: "2026-08-03",
    missed_working_days: 3,
    reports_next_day: false,
  };

  it("names the stream, the last report and the gap", () => {
    expect(describeStaleStream(base)).toBe(
      "RC Out (usage) — last reported 2026-07-29, 3 working days missed.",
    );
  });

  it("says 'day' not 'days' for one", () => {
    expect(describeStaleStream({ ...base, missed_working_days: 1 })).toContain("1 working day missed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A FAILED READ IS NOT AN EMPTY RESULT (2026-08-18, L-044)
//
// `findStaleStreams` ended in `catch { return [] }`. The worker's service role had NO
// SELECT grant on `view_digest_stream_status` — the denial cascaded up the
// `security_invoker` chain from `view_digest_operational_days` — so every read since the
// watch was built on 2026-08-04 returned
//     {"code":"42501","message":"permission denied for view view_digest_stream_status"}
// and that catch turned it into `[]`, which Stage 3e announced as "Every report stream is
// up to date." Measured: `stale_streams` is absent from EVERY run in `sync_runs`. The
// detector had never fired once, and its failure was indistinguishable from a healthy plant.
//
// `[]` must mean "I looked and nothing is late", NEVER "I could not look."
// ═══════════════════════════════════════════════════════════════════════════

/** The exact PostgREST error the worker got on every call for two weeks. */
const DENIED = 'permission denied for view view_digest_stream_status';

function db(rows: Row[] | Error): DbClient {
  return {
    readRows: async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    },
  } as unknown as DbClient;
}

describe("findStaleStreams — a failed read reports, it does not read as 'all clear'", () => {
  it("a healthy read with nothing late returns [] and NO error", async () => {
    const read = await findStaleStreams(db([row()]));
    expect(read.streams).toEqual([]);
    expect(read.error).toBeNull(); // the ONLY form that means "nothing is late"
  });

  it("a permission denial returns the MESSAGE, not a clean bill of health", async () => {
    const read = await findStaleStreams(db(new Error(DENIED)));
    expect(read.streams).toEqual([]);
    expect(read.error).toContain("permission denied");
    // The distinction the old code could not express — same empty list, opposite meaning.
    const healthy = await findStaleStreams(db([row()]));
    expect(healthy.streams).toEqual(read.streams);
    expect(healthy.error).not.toEqual(read.error);
  });

  it("still never throws — a watchdog may not fail the run it watches", async () => {
    await expect(findStaleStreams(db(new Error("boom")))).resolves.toBeDefined();
  });

  it("a late stream still comes through unchanged", async () => {
    const read = await findStaleStreams(db([row({ missed_working_days: 2 })]));
    expect(read.error).toBeNull();
    expect(read.streams).toHaveLength(1);
    expect(read.streams[0].missed_working_days).toBe(2);
  });
});

describe("findStreamStatus — three reasons a number can be missing, not one null", () => {
  it("a measured row carries the number and NO reason", async () => {
    const read = await findStreamStatus(
      db([row({ stream: "deliveries", label: "RC In (deliveries)", missed_working_days: 1 })]),
      "deliveries",
    );
    expect(read.missedWorkingDays).toBe(1);
    expect(read.unknownReason).toBeNull();
    expect(read.error).toBeNull();
    expect(read.status?.label).toBe("RC In (deliveries)");
  });

  it("zero is a MEASUREMENT, and is never confused with 'unknown'", async () => {
    const read = await findStreamStatus(db([row({ stream: "deliveries", missed_working_days: 0 })]), "deliveries");
    expect(read.missedWorkingDays).toBe(0);
    expect(read.unknownReason).toBeNull();
  });

  it("UNREADABLE — the grant failure — is named, and carries the DB's own words", async () => {
    const read = await findStreamStatus(db(new Error(DENIED)), "deliveries");
    expect(read.status).toBeNull();
    expect(read.missedWorkingDays).toBeNull();
    expect(read.unknownReason).toBe("unreadable");
    expect(read.error).toContain("permission denied");
  });

  it("UNREGISTERED — the view read fine and has no such stream — is a different fact", async () => {
    const read = await findStreamStatus(db([row({ stream: "rc_out" })]), "deliveries");
    expect(read.unknownReason).toBe("unregistered");
    expect(read.error).toBeNull(); // nothing failed; the registry simply has no row
  });

  it("NOT COMPUTABLE — the view's own SQL NULL — never becomes 0", async () => {
    // The view returns NULL when the stream has never reported. `asNum` would read that as
    // 0, i.e. "measured, and on time" — the `Number(null) === 0` trap one level down.
    const read = await findStreamStatus(
      db([row({ stream: "deliveries", through_date: null, missed_working_days: null })]),
      "deliveries",
    );
    expect(read.missedWorkingDays).toBeNull();
    expect(read.unknownReason).toBe("not_computable");
    expect(read.status?.through_date).toBeNull();
  });
});
