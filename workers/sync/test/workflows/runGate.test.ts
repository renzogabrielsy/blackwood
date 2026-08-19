/**
 * runGate.test.ts — ONE RUN AT A TIME (BUG-026, 2026-08-19).
 *
 * THE INCIDENT. A slow Gmail search made run 35bfc6eb look hung; the operator pressed Stop
 * at 03:30:08 and Run again at 03:31:05. The first run was still holding a live IMAP
 * session, so run 1a3bd336 opened a SECOND one on the same account — and Gmail throttles
 * concurrent IMAP sessions per account, so the replacement run sat on
 * `Looking for RC DELIVERIES…` for three and a half minutes. The retry made it worse.
 *
 * `lib/gmailSession.ts` cannot fix this: two overlapping runs are two legitimate lease
 * generations. The gate is the level above, and the headline assertion below is the one
 * that matters — **`peakLive` never exceeds 1 across two runs racing to start.**
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  withRunSlot,
  activeRunSlot,
  queuedRunSlots,
  _resetRunGateForTest,
} from "../../src/workflows/runGate.js";
import {
  withGmailSession,
  withGmailRunLease,
  gmailSessionStats,
  _configureGmailSessionForTest,
  _resetGmailSessionForTest,
} from "../../src/lib/gmailSession.js";
import type { GmailClient } from "../../src/lib/gmail.js";

class FakeClient {
  static connects = 0;
  static closes = 0;
  static live = 0;
  static peakLive = 0;
  usable = true;
  async connect(): Promise<void> {
    FakeClient.connects += 1;
    FakeClient.live += 1;
    FakeClient.peakLive = Math.max(FakeClient.peakLive, FakeClient.live);
  }
  async close(): Promise<void> {
    FakeClient.closes += 1;
    if (FakeClient.live > 0) FakeClient.live -= 1;
  }
  searchLatestAttachment = async (): Promise<unknown> => ({ ok: true, emails: [] });
  search = this.searchLatestAttachment;
  markProcessed = async (): Promise<boolean> => true;
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  _resetRunGateForTest();
  _resetGmailSessionForTest();
  _configureGmailSessionForTest({ factory: () => new FakeClient() as unknown as GmailClient });
  FakeClient.connects = 0;
  FakeClient.closes = 0;
  FakeClient.live = 0;
  FakeClient.peakLive = 0;
});

describe("one run at a time (BUG-026)", () => {
  it("a second run QUEUES instead of opening a second IMAP session", async () => {
    let releaseA!: () => void;
    const aHolding = new Promise<void>((r) => {
      releaseA = r;
    });
    let aStarted!: () => void;
    const aIsIn = new Promise<void>((r) => {
      aStarted = r;
    });

    // Run A: takes the slot, opens the session, and sits there (the 58-second search).
    const runA = withRunSlot("run-A", () =>
      withGmailRunLease(
        async () => {
          await withGmailSession(async () => "connected");
          aStarted();
          await aHolding;
          return "A";
        },
        { runId: "run-A" },
      ),
    );
    await aIsIn;
    expect(activeRunSlot()).toBe("run-A");
    expect(FakeClient.connects).toBe(1);

    // Run B: the operator's second click, 57 seconds later.
    const waited: string[] = [];
    let bTouchedGmail = false;
    const runB = withRunSlot(
      "run-B",
      () =>
        withGmailRunLease(
          async () => {
            await withGmailSession(async () => "connected");
            bTouchedGmail = true;
            return "B";
          },
          { runId: "run-B" },
        ),
      { onWait: (holder) => void waited.push(holder) },
    );

    await tick(20);
    // THE ASSERTION. B is parked; it has not touched Gmail and has not built a session.
    expect(activeRunSlot()).toBe("run-A");
    expect(queuedRunSlots()).toBe(1);
    expect(bTouchedGmail).toBe(false);
    expect(FakeClient.connects).toBe(1);
    expect(FakeClient.live).toBe(1);
    // …and it said so, naming the run it is waiting for.
    expect(waited).toEqual(["run-A"]);

    releaseA();
    expect(await runA).toBe("A");
    expect(await runB).toBe("B");

    expect(FakeClient.connects).toBe(2);
    // THE HEADLINE: never two live at once. This is the number that was 2 on 2026-08-19.
    expect(FakeClient.peakLive).toBe(1);
    expect(FakeClient.live).toBe(0);
    expect(activeRunSlot()).toBeNull();
    expect(gmailSessionStats().leases).toBe(0);
  });

  it("holds the slot through a run that is still UNWINDING from a failure", async () => {
    // The cancel-then-immediate-run window: run A is throwing its way out, and its Gmail
    // lease has not released yet. B must still wait — that window is exactly where the
    // operator's second click landed.
    let releaseA!: (err: Error) => void;
    const aBlocked = new Promise<never>((_r, reject) => {
      releaseA = reject;
    });
    let aStarted!: () => void;
    const aIsIn = new Promise<void>((r) => {
      aStarted = r;
    });

    const runA = withRunSlot("run-A", () =>
      withGmailRunLease(
        async () => {
          await withGmailSession(async () => "connected");
          aStarted();
          await aBlocked;
        },
        { runId: "run-A" },
      ),
    ).catch((e: Error) => e.message);
    await aIsIn;

    let bRan = false;
    const runB = withRunSlot("run-B", async () => {
      bRan = true;
      return "B";
    });
    await tick(20);
    expect(bRan).toBe(false);

    releaseA(new Error("stopped"));
    expect(await runA).toBe("stopped");
    expect(await runB).toBe("B");
    expect(activeRunSlot()).toBeNull();
  });

  it("is RE-ENTRANT for the same runId (a DBOS replay must not deadlock on itself)", async () => {
    const out = await withRunSlot("run-A", async () =>
      withRunSlot("run-A", async () => "nested"),
    );
    expect(out).toBe("nested");
    expect(activeRunSlot()).toBeNull();
  });

  it("wakes waiters in FIFO order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const isIn = new Promise<void>((r) => {
      started = r;
    });

    const a = withRunSlot("run-A", async () => {
      started();
      await held;
      order.push("A");
    });
    await isIn;
    const b = withRunSlot("run-B", async () => {
      order.push("B");
    });
    await tick(5);
    const c = withRunSlot("run-C", async () => {
      order.push("C");
    });
    await tick(5);
    expect(queuedRunSlots()).toBe(2);

    release();
    await Promise.all([a, b, c]);
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("gives up with a READABLE message rather than queueing forever", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const isIn = new Promise<void>((r) => {
      started = r;
    });
    const a = withRunSlot("run-A", async () => {
      started();
      await held;
    });
    await isIn;

    let bRan = false;
    await expect(
      withRunSlot(
        "run-B",
        async () => {
          bRan = true;
        },
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(/still running.*never started/is);
    // The refusal is honest: nothing was fetched and nothing was changed.
    expect(bRan).toBe(false);

    release();
    await a;
  });
});
