/**
 * batchCodeHousePrefix.test.ts — L-053 (2026-09-25): A WORKER THAT INVENTS NAMES MUST
 * INVENT THEM IN THE HOUSE CONVENTION.
 *
 * The deliveries extractor derived batch codes from MC's shorthand (`B12`,
 * `PILED IN SEPTEMBER # 12`, `FEEDING # 1`) through a local table that — despite being
 * called MONTH_ABBR_VALUES — held FULL month names, so the sync created
 * `SEPTEMBER-26-BLK12`, `SEPTEMBER-26-BLK1` and `SEPTEMBER-26-FEED1` while MC's typed
 * codes, the PROPOSED report's derivation and every other September pile read `SEPT-`.
 * The Google Sheet's Blocking tab looked D-12D up under the yard's spelling, the cell went
 * blank, and 39,570 kg dropped out of the Blocking cross-check.
 *
 * What this file pins:
 *   1. THE ONE table (`lib/months.ts::shortMonthPrefix`) and its twelve values.
 *   2. Every deliveries derivation rule (FEEDING, PILED IN, B-number) emits it, for every
 *      month; a verbatim code typed by a human passes through untouched.
 *   3. The PROPOSED report derives the same prefix (it always did — now from one table).
 *   4. The alias folds every long<->short pair of all twelve months, BOTH directions, so a
 *      source still typing the long form lands on the existing batch — and nothing wider.
 */
import { describe, it, expect } from "vitest";

import { BATCH_CODE_MONTH_PREFIX, MONTH_NAMES, shortMonthPrefix } from "../../src/lib/months.js";
import {
  batchCodeAliasEqual,
  resolveKnownBatchCodeAlias,
} from "../../src/lib/batchCodeAlias.js";
import { translateBatchCode } from "../../src/reports/deliveries/extract.js";
import { deriveBatchCodes } from "../../src/reports/rc_out/extract.js";

/** The house prefix, as measured on `batches` 2026-09-25 (see months.ts). */
const HOUSE = ["JAN", "FEB", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUG", "SEPT", "OCT", "NOV", "DEC"];

/** The other spelling of each month that lives (or lived) in `batches`. */
const LONG_OR_ALT: Record<string, string[]> = {
  JAN: ["JANUARY"],
  FEB: ["FEBRUARY"],
  MARCH: ["MAR"],
  APRIL: ["APR"],
  MAY: [],
  JUNE: ["JUN"],
  JULY: ["JUL"],
  AUG: ["AUGUST"],
  SEPT: ["SEPTEMBER"],
  OCT: ["OCTOBER"],
  NOV: ["NOVEMBER"],
  DEC: ["DECEMBER"],
};

const iso = (month: number, day = 5): string =>
  `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

describe("L-053 — THE one house batch-code prefix table", () => {
  it("has exactly the twelve measured values, in calendar order", () => {
    expect([...BATCH_CODE_MONTH_PREFIX]).toEqual(HOUSE);
    for (let m = 1; m <= 12; m++) expect(shortMonthPrefix(m)).toBe(HOUSE[m - 1]);
  });

  it("refuses an out-of-range month rather than inventing a prefix", () => {
    expect(() => shortMonthPrefix(0)).toThrow(RangeError);
    expect(() => shortMonthPrefix(13)).toThrow(RangeError);
  });

  it("is NOT the campaign name — production_batch stays the full month name", () => {
    expect(MONTH_NAMES[8]).toBe("SEPTEMBER");
    expect(shortMonthPrefix(9)).toBe("SEPT");
  });
});

describe("L-053 — every code the deliveries extractor DERIVES takes the house prefix", () => {
  it("FEEDING # N → <HOUSE>-YY-FEED<N>, every month", () => {
    for (let m = 1; m <= 12; m++) {
      const [code, warnings] = translateBatchCode("FEEDING # 6", null, iso(m));
      expect(code).toBe(`${HOUSE[m - 1]}-26-FEED6`);
      expect(warnings).toEqual([]);
    }
  });

  it("PILED IN <MONTH> # N (remark) → <HOUSE>-YY-BLK<N>, every month word", () => {
    for (let m = 1; m <= 12; m++) {
      const [code] = translateBatchCode("B99", `PILED IN ${MONTH_NAMES[m - 1]} # 12`, iso(9));
      expect(code).toBe(`${HOUSE[m - 1]}-26-BLK12`);
    }
  });

  it("B<N> → <HOUSE>-YY-BLK<N> from the delivery month, every month", () => {
    for (let m = 1; m <= 12; m++) {
      const [code, warnings] = translateBatchCode("B12", null, iso(m));
      expect(code).toBe(`${HOUSE[m - 1]}-26-BLK12`);
      expect(warnings.join(" ")).toContain(`used delivery month ${HOUSE[m - 1]}`);
    }
  });

  it("THE D-12D CASE: September shorthand derives SEPT-, never SEPTEMBER-", () => {
    expect(translateBatchCode("B12", null, "2026-09-24")[0]).toBe("SEPT-26-BLK12");
    expect(translateBatchCode("B1", "PILED IN SEPTEMBER # 1", "2026-09-02")[0]).toBe("SEPT-26-BLK1");
    expect(translateBatchCode("FEEDING # 1", null, "2026-09-03")[0]).toBe("SEPT-26-FEED1");
  });

  it("a verbatim code a human typed passes through untouched — long form included", () => {
    for (const typed of ["SEPTEMBER-26-BLK12", "AUGUST-26-BLK1", "MAR-24-BLK3", "SEPT-26-BLK2"]) {
      const [code, warnings] = translateBatchCode(typed, null, "2026-09-24");
      expect(code).toBe(typed);
      // still the pre-existing needs-mapping fallthrough warning, unchanged
      expect(warnings.join(" ")).toContain("Could not map operator batch label");
    }
  });
});

describe("L-053 — the PROPOSED report derives from the SAME table", () => {
  it("primary = house prefix for every month; fallback = the other spelling", () => {
    for (let m = 1; m <= 12; m++) {
      const [primary, fallback] = deriveBatchCodes({ year: 2026, month: m, day: 1 }, 12, false);
      expect(primary).toEqual([`${HOUSE[m - 1]}-26-BLK12`]);
      const alt = LONG_OR_ALT[HOUSE[m - 1]];
      if (m === 5 || m === 6 || m === 7) {
        // MAY/JUNE/JULY: primary and fallback spell alike → no fallback
        expect(fallback).toEqual([]);
      } else {
        expect(alt).toContain(fallback[0].split("-")[0]);
      }
    }
    expect(deriveBatchCodes({ year: 2026, month: 9, day: 1 }, 6, true)[0]).toEqual(["SEPT-26-FEED6"]);
  });

  it("deliveries and PROPOSED can no longer invent two spellings of one pile", () => {
    for (let m = 1; m <= 12; m++) {
      const fromEmail = translateBatchCode("B12", null, iso(m, 1))[0];
      const fromProposed = deriveBatchCodes({ year: 2026, month: m, day: 1 }, 12, false)[0][0];
      expect(fromEmail).toBe(fromProposed);
    }
  });
});

describe("L-053 — the alias folds every long<->short pair, both directions", () => {
  it("all twelve months, all spellings, both directions, every kind", () => {
    for (const house of HOUSE) {
      for (const other of LONG_OR_ALT[house]) {
        for (const suffix of ["BLK12", "FEED1", "SUNDRY2"]) {
          const a = `${house}-26-${suffix}`;
          const b = `${other}-26-${suffix}`;
          expect(batchCodeAliasEqual(a, b), `${a} ~ ${b}`).toBe(true);
          expect(batchCodeAliasEqual(b, a), `${b} ~ ${a}`).toBe(true);
          // case- and whitespace-insensitive, like the rest of the module
          expect(batchCodeAliasEqual(` ${b.toLowerCase()} `, a)).toBe(true);
        }
      }
    }
  });

  it("MAY is one word — identity only", () => {
    expect(batchCodeAliasEqual("MAY-26-BLK13", "MAY-26-BLK13")).toBe(true);
    expect(batchCodeAliasEqual("MAY-26-BLK13", "MAR-26-BLK13")).toBe(false);
  });

  it("folds nothing wider: month, year, suffix and SEP<->SEPT still differ", () => {
    expect(batchCodeAliasEqual("SEPT-26-BLK12", "AUG-26-BLK12")).toBe(false);
    expect(batchCodeAliasEqual("SEPT-26-BLK12", "SEPTEMBER-25-BLK12")).toBe(false);
    expect(batchCodeAliasEqual("SEPT-26-BLK12", "SEPTEMBER-26-BLK1")).toBe(false);
    expect(batchCodeAliasEqual("SEPT-26-BLK12", "SEPTEMBER-26-FEED12")).toBe(false);
    expect(batchCodeAliasEqual("SEP-26-BLK1", "SEPT-26-BLK1")).toBe(false);
    expect(batchCodeAliasEqual("JULY-26-BLK9", "JUNE-26-BLK9")).toBe(false);
  });

  it("a source still typing the LONG form lands on the existing SHORT batch", () => {
    const db = new Set(["SEPT-26-BLK12", "SEPT-26-BLK1", "SEPT-26-FEED1", "AUGUST-26-BLK1"]);
    expect(resolveKnownBatchCodeAlias("SEPTEMBER-26-BLK12", db)).toBe("SEPT-26-BLK12");
    expect(resolveKnownBatchCodeAlias("september-26-feed1", db)).toBe("SEPT-26-FEED1");
    // and a derived SHORT code lands on a pre-fix LONG batch that still exists
    expect(resolveKnownBatchCodeAlias("AUG-26-BLK1", db)).toBe("AUGUST-26-BLK1");
    // never invents: no batch under either spelling → no remap
    expect(resolveKnownBatchCodeAlias("SEPTEMBER-26-BLK99", db)).toBeNull();
    // never overrides a code that already resolves
    expect(resolveKnownBatchCodeAlias("SEPT-26-BLK12", db)).toBeNull();
  });
});
