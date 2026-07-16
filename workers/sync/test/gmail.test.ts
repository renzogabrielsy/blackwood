/**
 * gmail.test.ts — pure helpers (no network): safeFilename, globMatch, latestXlsx.
 * The live IMAP path is exercised separately by scripts/mailclerk-live-test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  safeFilename,
  globMatch,
  latestXlsx,
  findAttachmentPart,
  type GmailSearchResult,
  type FetchedEmail,
} from "../src/lib/gmail.js";
import type { MessageStructureObject } from "imapflow";

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

describe("findAttachmentPart (bodyStructure → attachment part number)", () => {
  const leaf = (
    part: string,
    filename?: string,
    nameParam?: string
  ): MessageStructureObject => ({
    part,
    type: filename ? "application/vnd...spreadsheet" : "text/plain",
    disposition: filename ? "attachment" : undefined,
    dispositionParameters: filename ? { filename } : undefined,
    parameters: nameParam ? { name: nameParam } : undefined,
  });

  it("finds the xlsx attachment part in a multipart tree", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        leaf("1"), // text body, no filename
        leaf("2", "RC DELIVERIES JUL-02.xlsx"),
      ],
    };
    const hit = findAttachmentPart(structure, ["*.xlsx", "*.xls"]);
    expect(hit).toEqual({ part: "2", filename: "RC DELIVERIES JUL-02.xlsx" });
  });

  it("falls back to the Content-Type name param when disposition filename is absent", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [leaf("1"), leaf("2", undefined, "waste.xls")],
    };
    // The name-param leaf has no disposition filename; give it a disposition too.
    (structure.childNodes![1] as MessageStructureObject).disposition = "attachment";
    const hit = findAttachmentPart(structure, ["*.xlsx", "*.xls"]);
    expect(hit).toEqual({ part: "2", filename: "waste.xls" });
  });

  it("returns null when no part matches the globs", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [leaf("1"), leaf("2", "note.pdf")],
    };
    expect(findAttachmentPart(structure, ["*.xlsx", "*.xls"])).toBe(null);
  });

  it("picks the FIRST matching leaf in nested multiparts", () => {
    const structure: MessageStructureObject = {
      type: "multipart/mixed",
      childNodes: [
        {
          type: "multipart/alternative",
          childNodes: [leaf("1.1"), leaf("1.2")],
        },
        leaf("2", "report.xlsx"),
      ],
    };
    expect(findAttachmentPart(structure, ["*.xlsx"])).toEqual({
      part: "2",
      filename: "report.xlsx",
    });
  });
});
