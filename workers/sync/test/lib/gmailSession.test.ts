/**
 * gmailSession.test.ts — BUG-019 Fix 1 + Fix 4.
 *
 * Proves the shared-session model with a FAKE GmailClient. NOTHING here touches a real
 * mailbox or opens a socket (Gmail is at its connection ceiling; a live call would
 * prolong the outage — hard constraint).
 *
 * WHAT IT PROVES
 *   1. A full run's Gmail work — mail-clerk fetch (7 queries) + 4 labelers + the flecon
 *      fetcher — opens exactly ONE session under the run lease. Without the lease the
 *      SAME work is what production did before the fix: it is the before/after counter,
 *      not an assertion. (A seventh user, the production-schedule fetcher at Stage 3c,
 *      was removed with that feature on 2026-08-28 — hence 6 where this once said 7.)
 *   2. The session is closed EXACTLY once, including on the error path.
 *   3. Concurrent callers (Stage 2b runs four writers in parallel) still make ONE connect.
 *   4. A failed connect is remembered — later callers in the same run do NOT open more
 *      sockets (four labelers must not become four more connection attempts).
 *   5. A dead socket (imapflow `usable === false`) is torn down before being replaced,
 *      so the replacement is never a second SIMULTANEOUS connection.
 *   6. The connection-limit finding surfaces with operator-readable text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  withGmailSession,
  withGmailRunLease,
  gmailSessionStats,
  gmailFailureHeldRows,
  describeGmailFailure,
  _configureGmailSessionForTest,
  _resetGmailSessionForTest,
} from "../../src/lib/gmailSession.js";
import type { GmailClient } from "../../src/lib/gmail.js";
import { makeLabeler, makeSingleLabeler, makeFleconFetcher } from "../../src/workflows/reportDeps.js";

// ── A fake GmailClient. Counts connects/closes; never opens a socket. ───────
interface FakeOpts {
  connectFails?: () => unknown;
  searchResult?: unknown;
}

class FakeClient {
  static built = 0;
  static connects = 0;
  static closes = 0;
  static logouts = 0;
  /** Live sessions right now, and the high-water mark. Peak MUST never exceed 1. */
  static live = 0;
  static peakLive = 0;
  usable = true;
  constructor(private readonly opts: FakeOpts = {}) {
    FakeClient.built += 1;
  }
  async connect(): Promise<void> {
    FakeClient.connects += 1;
    const fail = this.opts.connectFails?.();
    if (fail) throw fail;
    FakeClient.live += 1;
    FakeClient.peakLive = Math.max(FakeClient.peakLive, FakeClient.live);
  }
  async close(): Promise<void> {
    FakeClient.closes += 1;
    if (FakeClient.live > 0) FakeClient.live -= 1;
  }
  markProcessed = vi.fn(async () => true);
  search = vi.fn(async () => (this.opts.searchResult ?? { ok: true, query: "q", emailCount: 0, emails: [] }));
  searchLatestAttachment = vi.fn(async () => ({ ok: true, query: "q", emailCount: 0, emails: [] }));
}

function useFake(opts: FakeOpts = {}): void {
  _configureGmailSessionForTest({
    factory: () => new FakeClient(opts) as unknown as GmailClient,
  });
}

beforeEach(() => {
  _resetGmailSessionForTest();
  FakeClient.built = 0;
  FakeClient.connects = 0;
  FakeClient.closes = 0;
  FakeClient.logouts = 0;
  FakeClient.live = 0;
  FakeClient.peakLive = 0;
});

describe("one IMAP session per run (BUG-019 Fix 1)", () => {
  /**
   * The EXACT Gmail work a real run does, in order:
   *   Stage 1   mail clerk — 7 queries on one session
   *   Stage 2b  4 parallel writers, each labeling its thread
   *   Stage 2b  the flecon fetcher searching for its workbook
   * Before the fix each bullet after the first opened its own session: 1 + 4 + 1 = 6.
   * (It was 7 until 2026-08-28, when the Stage-3c schedule fetcher was removed along with
   * the rest of the production-schedule feature. The topology is what is being measured,
   * so the number moves with the work — it is not a fixed historical constant.)
   */
  /**
   * `parallelLabelers=false` mirrors reality: each writer labels at the END of its own
   * apply phase, at a different moment, in a different DBOS child workflow — the four
   * label calls do NOT reliably overlap. So the six Gmail users are effectively
   * sequential, and each one used to build its own client.
   */
  async function doAFullRunsGmailWork({ parallelLabelers = false } = {}): Promise<void> {
    // Stage 1 — the clerk's 7 queries.
    await withGmailSession(async (c) => {
      for (let i = 0; i < 7; i++) await c.searchLatestAttachment(`q${i}`);
    });
    // Stage 2b — the four writers' labelers.
    const labeler = makeLabeler(false);
    if (parallelLabelers) {
      await Promise.all([labeler([1]), labeler([2]), labeler([3]), labeler([4])]);
    } else {
      for (const uid of [1, 2, 3, 4]) await labeler([uid]);
    }
    // Stage 2b — flecon fetches its own workbook.
    await makeFleconFetcher()('subject:"FLECON BAGGED"');
  }

  it("opens ONE session for a whole run under the run lease (was 6)", async () => {
    useFake();
    await withGmailRunLease(() => doAFullRunsGmailWork());

    expect(FakeClient.connects).toBe(1);
    expect(FakeClient.closes).toBe(1);
    expect(FakeClient.peakLive).toBe(1); // never two live sessions at once
    expect(gmailSessionStats()).toMatchObject({ opens: 1, closes: 1, leases: 0, open: false });
  });

  it("the SAME work without the run lease is 6 sessions — that is what the lease removes", async () => {
    // The six Gmail users (clerk + 4 labelers + flecon) each open their own session when
    // nothing pins one for them. That is exactly the pre-fix topology, and sessions per
    // run against Gmail's ~15-connection cap is what broke production — it was 7 before
    // the schedule fetcher was removed on 2026-08-28, and the cap has not moved.
    useFake();
    await doAFullRunsGmailWork();
    expect(FakeClient.connects).toBe(6);
    expect(FakeClient.closes).toBe(6);
  });

  it("holds ONE session even when the four labelers really do overlap", async () => {
    useFake();
    await withGmailRunLease(() => doAFullRunsGmailWork({ parallelLabelers: true }));
    expect(FakeClient.connects).toBe(1);
    expect(FakeClient.peakLive).toBe(1);
  });

  it("closes the session exactly once even when the run throws", async () => {
    useFake();
    await expect(
      withGmailRunLease(async () => {
        await withGmailSession(async (c) => {
          await c.markProcessed([1]);
        });
        throw new Error("stage 2 blew up");
      }),
    ).rejects.toThrow("stage 2 blew up");

    expect(FakeClient.connects).toBe(1);
    expect(FakeClient.closes).toBe(1);
    expect(gmailSessionStats()).toMatchObject({ leases: 0, open: false });
  });

  it("makes ONE connect when four callers race (the parallel-writer case)", async () => {
    useFake();
    const labeler = makeLabeler(false);
    const single = makeSingleLabeler(false);
    await withGmailRunLease(async () => {
      await Promise.all([labeler([1]), labeler([2]), single("3"), single("4")]);
    });
    expect(FakeClient.connects).toBe(1);
    expect(FakeClient.closes).toBe(1);
  });

  it("remembers a failed connect — later callers never open another socket", async () => {
    const refusal = Object.assign(new Error("Command failed"), {
      responseStatus: "NO",
      serverResponseCode: "ALERT",
      responseText: "Too many simultaneous connections. (Failure)",
      authenticationFailed: true,
    });
    useFake({ connectFails: () => refusal });

    const labeler = makeLabeler(false);
    const seen: unknown[] = [];
    await withGmailRunLease(async () => {
      for (let i = 0; i < 4; i++) {
        await labeler([i]).catch((e) => seen.push(e));
      }
    });

    // FOUR labelers, exactly ONE connection attempt. During a connection-limit outage
    // retrying per-caller is what turns a stumble into a stampede.
    expect(FakeClient.connects).toBe(1);
    expect(seen).toHaveLength(4);
    expect(seen.every((e) => e === refusal)).toBe(true);
  });

  it("replaces a DEAD socket without ever holding two at once", async () => {
    useFake();
    await withGmailRunLease(async () => {
      const first = await withGmailSession(async (c) => c);
      expect(FakeClient.connects).toBe(1);
      // imapflow dropped the socket while the run idled (socketTimeout).
      (first as unknown as FakeClient).usable = false;
      await withGmailSession(async (c) => {
        expect(c).not.toBe(first);
      });
      // The dead one was CLOSED before the replacement was opened.
      expect(FakeClient.closes).toBe(1);
      expect(FakeClient.connects).toBe(2);
    });
    expect(FakeClient.closes).toBe(2); // the replacement closed at lease release
    expect(gmailSessionStats()).toMatchObject({ open: false, leases: 0 });
  });
});

describe("connection-limit run finding (BUG-019 Fix 4)", () => {
  const refusal = Object.assign(new Error("Command failed"), {
    responseStatus: "NO",
    serverResponseCode: "ALERT",
    responseText: "Too many simultaneous connections. (Failure)",
    authenticationFailed: true,
  });

  it("produces ONE gate_failure held row an operator can act on", () => {
    const rows = gmailFailureHeldRows("deliveries", refusal);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    // Uses an EXISTING HeldKind — the enum is frontend-locked.
    expect(row.kind).toBe("gate_failure");
    expect(row.natural_key).toMatch(/connection limit/i);
    // `reason` is the panel's TITLE for a held row with no batch code — plain English,
    // never a slug like "gmail_connection_limit".
    expect(row.reason).toMatch(/^Gmail refused the connection/);
    expect(row.reason).toMatch(/run the sync again/i);
    expect(row.reason).not.toMatch(/_/);
    expect(row.detail).toMatch(/Gmail connection limit hit/i);
    // The SERVER's own words are in the detail — this is what "Command failed" hid.
    expect(row.detail).toContain("Too many simultaneous connections");
    expect(row.row).toMatchObject({ report: "deliveries" });
  });

  it("says nothing for any other failure (behaviour unchanged)", () => {
    expect(gmailFailureHeldRows("rc_out", new Error("Storage download failed"))).toEqual([]);
    expect(gmailFailureHeldRows("rc_out", new Error("Invalid credentials"))).toEqual([]);
  });

  it("describeGmailFailure never returns a bare 'Command failed'", () => {
    const described = describeGmailFailure(refusal);
    expect(described).not.toBe("Command failed");
    expect(described).toMatch(/Gmail connection limit hit/);
    // A non-Gmail error passes through untouched.
    expect(describeGmailFailure(new Error("boom"))).toBe("boom");
  });
});
