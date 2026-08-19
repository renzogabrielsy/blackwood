/**
 * gmailSessionAbort.test.ts — STOP TEARS DOWN THE SOCKET (BUG-026, 2026-08-19).
 *
 * THE INCIDENT THESE TESTS PIN. Run 35bfc6eb: the RC DELIVERIES IMAP search took 58 s
 * (4–7 s on every earlier run that day, identical build — Gmail was slow). The operator
 * pressed Stop at 03:30:08; `sync_runs` flipped to `cancelled` immediately. Then, at
 * **03:32:57 — 2 min 49 s AFTER the cancel — the cancelled run emitted `Found RC
 * DELIVERIES (98 KB)`** and carried on. DBOS observes a cancellation only when a STEP
 * RETURNS, and the run was parked mid-`await` inside one. Cancelling a workflow does not
 * cancel a socket.
 *
 * WHAT IS PROVED HERE, and it is the exact property the fix promises:
 *   1. Stop during a slow search rejects the awaiting caller PROMPTLY — measured, not
 *      assumed — with a cancellation-shaped error `runSync::isCancellation` recognises.
 *   2. The session is CLOSED by the abort, exactly once, and the lease still unwinds
 *      cleanly afterwards (no leaked lease, no double close).
 *   3. The abort is STICKY past the lease: a labeler still unwinding inside a cancelled
 *      child workflow gets the same rejection instead of opening a fresh socket.
 *   4. A cancel for a DIFFERENT run can never tear down this run's session.
 *   5. A NEW run clears the abort and connects normally.
 *
 * NOTHING here touches a real mailbox or opens a socket.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  withGmailSession,
  withGmailRunLease,
  abortActiveGmailSession,
  isGmailSessionAborted,
  gmailSessionStats,
  describeGmailFailure,
  _configureGmailSessionForTest,
  _resetGmailSessionForTest,
} from "../../src/lib/gmailSession.js";
import type { GmailClient } from "../../src/lib/gmail.js";
import { isCancellation } from "../../src/workflows/runSync.js";

/** A client whose search NEVER resolves on its own — "Gmail is being slow". */
class StuckClient {
  static built = 0;
  static connects = 0;
  static closes = 0;
  static live = 0;
  static peakLive = 0;
  usable = true;
  constructor() {
    StuckClient.built += 1;
  }
  async connect(): Promise<void> {
    StuckClient.connects += 1;
    StuckClient.live += 1;
    StuckClient.peakLive = Math.max(StuckClient.peakLive, StuckClient.live);
  }
  async close(): Promise<void> {
    StuckClient.closes += 1;
    if (StuckClient.live > 0) StuckClient.live -= 1;
  }
  /** Hangs forever, exactly like an IMAP command Gmail has not answered yet. */
  searchLatestAttachment(): Promise<never> {
    return new Promise<never>(() => {
      /* never settles */
    });
  }
  search = this.searchLatestAttachment;
  markProcessed = async (): Promise<boolean> => true;
}

function useStuck(): void {
  _configureGmailSessionForTest({
    factory: () => new StuckClient() as unknown as GmailClient,
  });
}

/** Resolves once `p` settles OR `ms` elapses — so a hang fails the test instead of it. */
function settledWithin<T>(p: Promise<T>, ms: number): Promise<"settled" | "timeout"> {
  return Promise.race([
    p.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms)),
  ]);
}

beforeEach(() => {
  _resetGmailSessionForTest();
  StuckClient.built = 0;
  StuckClient.connects = 0;
  StuckClient.closes = 0;
  StuckClient.live = 0;
  StuckClient.peakLive = 0;
});

describe("Stop during a slow Gmail search (BUG-026)", () => {
  it("rejects the awaiting search PROMPTLY and closes the session", async () => {
    useStuck();
    let searchStarted!: () => void;
    const started = new Promise<void>((r) => {
      searchStarted = r;
    });

    const run = withGmailRunLease(
      () =>
        withGmailSession(async (gmail) => {
          searchStarted();
          // The 58-second search. Without the abort this never comes back.
          return gmail.searchLatestAttachment("subject:\"RC DELIVERIES\"", { patterns: [] });
        }),
      { runId: "run-A" },
    );

    await started;
    expect(StuckClient.connects).toBe(1);
    expect(gmailSessionStats().open).toBe(true);

    const t0 = Date.now();
    // No custom reason — this asserts the wording an operator actually reads.
    const aborted = await abortActiveGmailSession({ runId: "run-A" });
    expect(aborted).toBe(true);

    // THE PROPERTY: the awaiting step rejects NOW, not when Gmail eventually answers.
    expect(await settledWithin(run, 1000)).toBe("settled");
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);

    await expect(run).rejects.toThrow(/stopped/i);
    const err = await run.catch((e: unknown) => e);
    expect(isGmailSessionAborted(err)).toBe(true);
    // …and the run settles 'cancelled', never 'failed'.
    expect(isCancellation(err)).toBe(true);
    // A readable sentence for the progress beat, never "Command failed".
    expect(describeGmailFailure(err)).toMatch(/stopped/i);

    // The socket was released, once, and the lease unwound cleanly behind it.
    expect(StuckClient.closes).toBe(1);
    expect(StuckClient.live).toBe(0);
    expect(gmailSessionStats().leases).toBe(0);
    expect(gmailSessionStats().open).toBe(false);
  });

  it("does NOT re-open a socket for a straggler after the lease released (no zombie)", async () => {
    useStuck();
    let searchStarted!: () => void;
    const started = new Promise<void>((r) => {
      searchStarted = r;
    });
    const run = withGmailRunLease(
      () =>
        withGmailSession(async (gmail) => {
          searchStarted();
          return gmail.searchLatestAttachment("q", { patterns: [] });
        }),
      { runId: "run-A" },
    );
    await started;
    await abortActiveGmailSession({ runId: "run-A" });
    await run.catch(() => undefined);
    expect(gmailSessionStats().leases).toBe(0);

    // A labeler inside a still-unwinding child workflow, arriving AFTER the lease died.
    // Before the sticky abort this opened a brand-new session for a stopped run.
    const straggler = withGmailSession(async () => "labeled");
    await expect(straggler).rejects.toThrow(/stopped/i);
    expect(StuckClient.connects).toBe(1);
    expect(StuckClient.built).toBe(1);
  });

  it("refuses to tear down a session a DIFFERENT run owns", async () => {
    useStuck();
    let searchStarted!: () => void;
    const started = new Promise<void>((r) => {
      searchStarted = r;
    });
    const run = withGmailRunLease(
      () =>
        withGmailSession(async (gmail) => {
          searchStarted();
          return gmail.searchLatestAttachment("q", { patterns: [] });
        }),
      { runId: "run-A" },
    );
    await started;

    const aborted = await abortActiveGmailSession({ runId: "run-B" });
    expect(aborted).toBe(false);
    expect(gmailSessionStats().open).toBe(true);
    expect(StuckClient.closes).toBe(0);
    expect(await settledWithin(run, 150)).toBe("timeout");

    // Clean up: the real owner can still stop it.
    await abortActiveGmailSession({ runId: "run-A" });
    await run.catch(() => undefined);
  });

  it("a cancel that arrives before the run reached Gmail is a plain no-op", async () => {
    useStuck();
    expect(await abortActiveGmailSession({ runId: "run-A" })).toBe(false);
    expect(StuckClient.built).toBe(0);
  });

  it("a NEW run clears the abort and connects normally", async () => {
    useStuck();
    let searchStarted!: () => void;
    const started = new Promise<void>((r) => {
      searchStarted = r;
    });
    const first = withGmailRunLease(
      () =>
        withGmailSession(async (gmail) => {
          searchStarted();
          return gmail.searchLatestAttachment("q", { patterns: [] });
        }),
      { runId: "run-A" },
    );
    await started;
    await abortActiveGmailSession({ runId: "run-A" });
    await first.catch(() => undefined);

    const out = await withGmailRunLease(
      () => withGmailSession(async () => "ok"),
      { runId: "run-B" },
    );
    expect(out).toBe("ok");
    expect(StuckClient.connects).toBe(2);
    // Still never two live at once — the first was closed before the second opened.
    expect(StuckClient.peakLive).toBe(1);
  });
});
