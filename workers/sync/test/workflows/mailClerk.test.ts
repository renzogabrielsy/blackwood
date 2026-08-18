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

// ── Mock ONLY the GmailClient class so no network is touched. The rest of
// src/lib/gmail.js (error classification helpers used by gmailSession.ts) stays real.
const searchLatestAttachment = vi.fn();
const search = vi.fn();
const connect = vi.fn(async () => {});
const close = vi.fn(async () => {});

vi.mock("../../src/lib/gmail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/gmail.js")>();
  class FakeGmailClient {
    static fromEnv() {
      return new FakeGmailClient();
    }
    usable = true;
    connect = connect;
    close = close;
    searchLatestAttachment = searchLatestAttachment;
    search = search;
  }
  return { ...actual, GmailClient: FakeGmailClient };
});

import {
  runMailClerk,
  mailQueries,
  normalizeAttachmentName,
} from "../../src/workflows/mailClerk.js";
import {
  gmailSessionStats,
  _resetGmailSessionForTest,
} from "../../src/lib/gmailSession.js";

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

/**
 * The filename the mailbox hands back for a query.
 *
 * The Czarina query now REQUIRES the price file by name (L-044), so a mock that answers
 * every query with "report.xlsx" would be modelling a mailbox in which the price file
 * never arrives. `filename:` + the per-query attachment globs are what make the real
 * mailbox answer with the right document, so the fixture answers the same way.
 */
function mockFilenameFor(query: string): string {
  return query.includes("czarinaloumaximoictc")
    ? "RAW CHARCOAL PURCHASES -Daily.xlsx"
    : "report.xlsx";
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetGmailSessionForTest();
  // Every query returns one email carrying an xlsx that query would actually accept.
  searchLatestAttachment.mockImplementation(async (query: string) => ({
    ok: true,
    query,
    emailCount: 1,
    emails: [emailWith(100, mockFilenameFor(query), 87 * 1024)],
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

  it("opens exactly ONE IMAP session for all seven queries, and closes it (BUG-019)", async () => {
    await runMailClerk({ runId: "r", since: "2026/05/01", dryRun: true });
    expect(searchLatestAttachment).toHaveBeenCalledTimes(mailQueries().length);
    // 7 queries, ONE connect, ONE close — the clerk never opens a client per report.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(gmailSessionStats()).toMatchObject({ opens: 1, closes: 1, leases: 0, open: false });
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
      const name = mockFilenameFor(q.query);
      expect(manifest.reports[q.key]).toHaveLength(1);
      expect(manifest.reports[q.key][0].storagePath).toBe(`run-xyz/${q.key}/${name}`);
    }
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PRICE FILE IS IDENTIFIED BY NAME, NOT BY SENDER (2026-08-18, L-044)
//
// The Czarina query was `from:… newer_than:5d` and nothing else, and the clerk took the
// newest .xlsx she had sent. Measured over two weeks it had used ALL of these as "the
// price list": `RAW CHARCOAL PURCHASES -Daily(1).xlsx` (correct), `BDO REQUISTION DETAILS
// & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx`, `VAN LOADING FILE.xlsx`,
// `POWDER ( l. RIVERA).xlsx`. The BDO workbook has a tab called `AUGUST 2026`, so every
// downstream check was satisfied by a bank cheque ledger and four truckloads went in at ₱0.
// ═══════════════════════════════════════════════════════════════════════════
describe("Czarina price file — identified by NAME (L-044)", () => {
  const czarina = () => mailQueries().find((q) => q.key === "deliveries_czarina")!;

  it("normalizes the ways a human-typed filename actually drifts", () => {
    const want = "RAW CHARCOAL PURCHASES DAILY";
    for (const n of [
      "RAW CHARCOAL PURCHASES -Daily.xlsx",
      "RAW CHARCOAL PURCHASES -Daily(1).xlsx",
      "raw charcoal purchases - daily.xlsx",
      "RAW  CHARCOAL   PURCHASES-Daily.XLSX",
      "RAW_CHARCOAL_PURCHASES_Daily.xls",
    ]) {
      expect(normalizeAttachmentName(n)).toBe(want);
    }
  });

  it("ACCEPTS her real filenames and REFUSES every workbook that was wrongly used", () => {
    const match = czarina().attachmentMatches!;
    // The two spellings the price file actually arrives under.
    expect(match("RAW CHARCOAL PURCHASES -Daily.xlsx")).toBe(true);
    expect(match("RAW CHARCOAL PURCHASES -Daily(1).xlsx")).toBe(true);
    // The three real workbooks the sync mistook for it.
    expect(
      match("BDO REQUISTION DETAILS & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx")
    ).toBe(false);
    expect(match("VAN LOADING FILE.xlsx")).toBe(false);
    expect(match("POWDER ( l. RIVERA).xlsx")).toBe(false);
  });

  it("stores NOTHING rather than the wrong workbook", async () => {
    searchLatestAttachment.mockImplementation(async (query: string) => ({
      ok: true,
      query,
      emailCount: 1,
      emails: query.includes("czarinaloumaximoictc")
        ? [emailWith(101, "BDO REQUISTION DETAILS & WEEKLY CHECK ISSUANCE (REVISED)-2026.xlsx", 4096)]
        : [emailWith(100, "report.xlsx", 4096)],
    }));

    const warns: { label: string; detail?: string }[] = [];
    const onProgress = vi.fn(async (_s, label, _p, detail, level) => {
      if (level === "warn") warns.push({ label: label as string, detail: detail as string });
    });

    const manifest = await runMailClerk(
      { runId: "r", since: "2026/05/01", dryRun: true },
      onProgress as never
    );

    // An ABSENT price file is a state every consumer already handles and reports; the
    // WRONG one is indistinguishable from the right one all the way down.
    expect(manifest.reports.deliveries_czarina).toEqual([]);
    // Every other report is untouched — the guard is scoped to the one exposed query.
    expect(manifest.reports.deliveries).toHaveLength(1);
    // And it SAYS what it skipped, naming the file. This beat is the one that was missing.
    const skipped = warns.find((w) => /not that file/i.test(w.label));
    expect(skipped).toBeTruthy();
    expect(skipped!.detail).toContain("BDO REQUISTION");
  });

  it("RECOVERS the right file when a newer, wrong workbook sits in front of it", async () => {
    // The clerk asks Gmail for the parts matching its OWN globs, so the mailbox hands back
    // the newest matching one — this asserts the clerk does not simply take the last email.
    searchLatestAttachment.mockImplementation(async (query: string, opts?: { patterns?: string[] }) => {
      if (!query.includes("czarinaloumaximoictc")) {
        return { ok: true, query, emailCount: 1, emails: [emailWith(100, "report.xlsx", 4096)] };
      }
      // The narrowed glob is what makes this possible — assert it was actually sent.
      expect(opts?.patterns).toEqual(["*raw*charcoal*purchase*.xls*"]);
      return {
        ok: true,
        query,
        emailCount: 2,
        emails: [
          emailWith(101, "RAW CHARCOAL PURCHASES -Daily(1).xlsx", 4096),
          // Newest, and NOT the price file — metadata-only in the real fast path.
          { ...emailWith(102, "VAN LOADING FILE.xlsx", 4096), attachments: [] },
        ],
      };
    });

    const manifest = await runMailClerk({ runId: "r", since: "2026/05/01", dryRun: true });
    expect(manifest.reports.deliveries_czarina).toHaveLength(1);
    expect(manifest.reports.deliveries_czarina[0].filename).toBe(
      "RAW CHARCOAL PURCHASES -Daily(1).xlsx"
    );
  });

  it("leaves the other six queries unguarded — they are pinned by subject/label already", () => {
    for (const q of mailQueries()) {
      if (q.key === "deliveries_czarina") continue;
      expect(q.attachmentMatches).toBeUndefined();
      expect(q.attachmentPatterns).toBeUndefined();
    }
  });
});
