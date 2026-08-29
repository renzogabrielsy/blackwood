/**
 * senderRoster.test.ts — WHO SENT IT IS A ROSTER, NOT AN IDENTITY (2026-08-29, L-045).
 *
 * MC was out; Ivy sent his Daily Production Report on 2026-08-28 and 2026-08-29. The
 * search was pinned to MC's address alone, so both were invisible and production,
 * electricity and trucks went stale together while the workbook sat in the inbox.
 *
 * These tests pin the roster itself: the clause it renders, the fact that the two people
 * in the incident are both in it, and that an empty roster is a THROW rather than a
 * `from:()` that Gmail would treat as no constraint at all.
 */
import { describe, it, expect } from "vitest";
import {
  ICTC_SENDER_ROSTER,
  ICTC_SENDER_ADDRESSES,
  rosterFrom,
  rosterMemberFor,
} from "../../src/lib/senderRoster.js";

const MC = "mccontinedo.ictc@gmail.com";
const IVY = "edilloivymae306ictc@gmail.com";
const CZARINA = "czarinaloumaximoictc@gmail.com";

describe("the ICTC sender roster", () => {
  it("contains BOTH people in the incident — either may send for the other", () => {
    expect(ICTC_SENDER_ADDRESSES).toContain(MC);
    expect(ICTC_SENDER_ADDRESSES).toContain(IVY);
  });

  it("is exactly the addresses this repo already knew — nothing invented", () => {
    expect([...ICTC_SENDER_ADDRESSES]).toEqual([
      MC,
      IVY,
      CZARINA,
      "angelicagustilo26.ictc@gmail.com",
    ]);
  });

  it("holds lower-cased, unique, well-formed addresses, each with a stated source", () => {
    const seen = new Set<string>();
    for (const m of ICTC_SENDER_ROSTER) {
      expect(m.address).toBe(m.address.toLowerCase());
      expect(m.address).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]+$/);
      expect(seen.has(m.address)).toBe(false);
      seen.add(m.address);
      // An address without provenance is an invented one.
      expect(m.source.trim().length).toBeGreaterThan(0);
      expect(m.person.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("rosterFrom()", () => {
  it("renders the whole roster as ONE parenthesised OR clause, in declaration order", () => {
    expect(rosterFrom()).toBe(
      `from:(${MC} OR ${IVY} OR ${CZARINA} OR angelicagustilo26.ictc@gmail.com)`
    );
  });

  it("renders a single address in the plain form these queries always used", () => {
    expect(rosterFrom([MC])).toBe(`from:${MC}`);
  });

  it("REFUSES an empty roster instead of emitting `from:()`", () => {
    // `from:()` is not a narrower search — it is no search constraint at all, which is
    // the failure mode this whole file exists to prevent, inverted.
    expect(() => rosterFrom([])).toThrow(/empty roster/i);
    expect(() => rosterFrom(["", "   "])).toThrow(/empty roster/i);
  });
});

describe("rosterMemberFor() — for READING a fetched email, never for fetching one", () => {
  it("resolves a bare address and a `Name <address>` envelope, case-insensitively", () => {
    expect(rosterMemberFor(IVY)?.person).toBe("Ivy Mae Edillo");
    expect(rosterMemberFor(`Ivy Mae Edillo <${IVY.toUpperCase()}>`)?.person).toBe(
      "Ivy Mae Edillo"
    );
  });

  it("returns null for an off-roster sender and for nothing at all", () => {
    expect(rosterMemberFor("someone.else@example.com")).toBeNull();
    expect(rosterMemberFor("")).toBeNull();
    expect(rosterMemberFor(null)).toBeNull();
    expect(rosterMemberFor(undefined)).toBeNull();
  });
});
