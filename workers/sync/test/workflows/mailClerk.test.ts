/**
 * mailClerk.test.ts — the DBOS-free runMailClerk path with a MOCKED GmailClient.
 *
 * Proves the live-progress contract (FIX 1): the fetch emits a progress beat per
 * report in order, with honest climbing pct and real filenames/sizes — without
 * touching a real mailbox. Also proves the attachment-only fast path is the one
 * used (searchLatestAttachment), with a per-report fallback to full-source search.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FetchedEmail } from "../../src/lib/gmail.js";

// ── Mock the Gmail client so no network is touched. ─────────────────────────
const searchLatestAttachment = vi.fn();
const search = vi.fn();
const connect = vi.fn(async () => {});
const close = vi.fn(async () => {});

vi.mock("../../src/lib/gmail.js", () => {
  class FakeGmailClient {
    static fromEnv() {
      return new FakeGmailClient();
    }
    connect = connect;
    close = close;
    searchLatestAttachment = searchLatestAttachment;
    search = search;
  }
  return { GmailClient: FakeGmailClient };
});

import { runMailClerk, mailQueries } from "../../src/workflows/mailClerk.js";

function emailWith(uid: number, filename: string, sizeBytes: number): FetchedEmail {
  return {
    uid,
    threadId: `t${uid}`,
    subject: `S${uid}`,
    sender: "x@example.com",
    date: new Date("2026-07-02T00:00:00Z").toISOString(),
    sizeBytes,
    attachments: [
      {
        filename,
        path: null,
        content: Buffer.alloc(sizeBytes, 1),
        sizeBytes,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        isInline: false,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every query returns one email carrying a distinct xlsx.
  searchLatestAttachment.mockImplementation(async (query: string) => ({
    ok: true,
    query,
    emailCount: 1,
    emails: [emailWith(100, "report.xlsx", 87 * 1024)],
  }));
});

describe("runMailClerk live progress (FIX 1)", () => {
  it("emits a progress beat per report, in order, with honest climbing pct", async () => {
    const events: { label: string; pct: number; detail?: string }[] = [];
    const onProgress = vi.fn(async (_stage, label, pct, detail) => {
      events.push({ label, pct, detail });
    });

    await runMailClerk(
      { runId: "test-run", since: "2026/05/01", dryRun: true },
      onProgress as never
    );

    // Connect beat first.
    expect(events[0].label).toMatch(/Connecting to Gmail/i);

    // One "Downloaded N of M" beat per report, counting up.
    const downloaded = events.filter((e) => /Downloaded \d+ of \d+/.test(e.label));
    expect(downloaded.length).toBe(mailQueries().length);
    downloaded.forEach((e, i) => {
      expect(e.label).toBe(`Downloaded ${i + 1} of ${mailQueries().length} reports…`);
    });

    // A "Found …" beat carrying the real filename + human size.
    const found = events.filter((e) => /^Found /.test(e.label));
    expect(found.length).toBe(mailQueries().length);
    expect(found[0].label).toMatch(/\(87 KB\)/);
    expect(found[0].detail).toBe("report.xlsx");

    // pct is monotonic nondecreasing and lands within the fetch band (≤25).
    const pcts = events.map((e) => e.pct);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    expect(Math.max(...pcts)).toBeLessThanOrEqual(25);
    expect(Math.min(...pcts)).toBeGreaterThanOrEqual(4);
  });

  it("uses the attachment-only fast path (searchLatestAttachment), not full source", async () => {
    await runMailClerk({ runId: "r", since: "2026/05/01", dryRun: true });
    expect(searchLatestAttachment).toHaveBeenCalledTimes(mailQueries().length);
    expect(search).not.toHaveBeenCalled();
  });

  it("falls back to full-source search for a report whose fast path throws", async () => {
    // First query's fast path throws once; the rest succeed.
    searchLatestAttachment.mockImplementationOnce(async () => {
      throw new Error("bodyStructure part unavailable");
    });
    search.mockImplementation(async (query: string) => ({
      ok: true,
      query,
      emailCount: 1,
      emails: [emailWith(200, "fallback.xlsx", 12 * 1024)],
    }));

    const warns: string[] = [];
    const onProgress = vi.fn(async (_s, label, _p, _d, level) => {
      if (level === "warn") warns.push(label as string);
    });

    const manifest = await runMailClerk(
      { runId: "r", since: "2026/05/01", dryRun: true },
      onProgress as never
    );

    // Full-source search was used exactly once (the fallback).
    expect(search).toHaveBeenCalledTimes(1);
    // A warn beat announced the slow retry.
    expect(warns.some((w) => /slow way/i.test(w))).toBe(true);
    // The fallback file made it into the manifest for the first query.
    const firstKey = mailQueries()[0].key;
    expect(manifest.reports[firstKey][0].filename).toBe("fallback.xlsx");
  });

  it("never uploads on dryRun and builds a manifest of the expected shape", async () => {
    const manifest = await runMailClerk({
      runId: "run-xyz",
      since: "2026/05/01",
      dryRun: true,
    });
    expect(manifest.runId).toBe("run-xyz");
    for (const q of mailQueries()) {
      expect(manifest.reports[q.key]).toHaveLength(1);
      expect(manifest.reports[q.key][0].storagePath).toBe(
        `run-xyz/${q.key}/report.xlsx`
      );
    }
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
