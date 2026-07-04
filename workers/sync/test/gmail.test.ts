/**
 * gmail.test.ts — pure helpers (no network): safeFilename, globMatch, latestXlsx.
 * The live IMAP path is exercised separately by scripts/mailclerk-live-test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  safeFilename,
  globMatch,
  latestXlsx,
  type GmailSearchResult,
  type FetchedEmail,
} from "../src/lib/gmail.js";

describe("safeFilename (fetch_gmail.safe_filename parity)", () => {
  it("strips path separators to the basename", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Users\\x\\RC DELIVERIES.xlsx")).toBe("RC DELIVERIES.xlsx");
  });
  it("replaces unsafe characters with underscore", () => {
    expect(safeFilename("re;port*name?.xlsx")).toBe("re_port_name_.xlsx");
  });
  it("falls back to 'attachment' when empty", () => {
    expect(safeFilename("///")).toBe("attachment");
  });
  it("caps overly long names but preserves extension", () => {
    const long = "a".repeat(300) + ".xlsx";
    const out = safeFilename(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(".xlsx")).toBe(true);
  });
});

describe("globMatch", () => {
  it("matches *.xlsx case-insensitively", () => {
    expect(globMatch("report.xlsx", "*.xlsx")).toBe(true);
    expect(globMatch("REPORT.XLSX", "*.xlsx")).toBe(true);
    expect(globMatch("report.xls", "*.xls")).toBe(true);
  });
  it("does not match a different extension", () => {
    expect(globMatch("report.pdf", "*.xlsx")).toBe(false);
  });
});

function em(uid: number, atts: string[]): FetchedEmail {
  return {
    uid,
    threadId: `t${uid}`,
    subject: `S${uid}`,
    sender: "x",
    date: null,
    sizeBytes: 0,
    attachments: atts.map((f) => ({
      filename: f,
      path: null,
      content: Buffer.from(""),
      sizeBytes: 0,
      mimeType: "application/octet-stream",
      isInline: false,
    })),
  };
}

describe("latestXlsx (orchestrator_common.latest_xlsx parity)", () => {
  it("picks the NEWEST email with an xlsx (emails ascending, newest last)", () => {
    const res: GmailSearchResult = {
      ok: true,
      query: "q",
      emailCount: 3,
      emails: [em(1, ["old.xlsx"]), em(2, ["note.pdf"]), em(3, ["new.xlsx"])],
    };
    const got = latestXlsx(res);
    expect(got?.email.uid).toBe(3);
    expect(got?.attachment.filename).toBe("new.xlsx");
  });

  it("skips newer emails without an xlsx and falls back to the latest that has one", () => {
    const res: GmailSearchResult = {
      ok: true,
      query: "q",
      emailCount: 2,
      emails: [em(5, ["has.xlsx"]), em(9, ["nope.txt"])],
    };
    expect(latestXlsx(res)?.email.uid).toBe(5);
  });

  it("returns null when no email has an xlsx", () => {
    const res: GmailSearchResult = {
      ok: true,
      query: "q",
      emailCount: 1,
      emails: [em(1, ["a.pdf"])],
    };
    expect(latestXlsx(res)).toBe(null);
  });
});
