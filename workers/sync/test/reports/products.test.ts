/**
 * products.test.ts — the `products` report against the REAL PRODUCTS INVENTORY workbook.
 *
 * The fixture is committed (test/fixtures/products-inventory-2026-09-07.xlsx) rather than
 * read from a path outside the repo, deliberately: the whole value of these assertions is
 * that they reproduce the SHEET'S OWN ARITHMETIC, and a gate that silently skips when a
 * file is missing is not a gate — the project's own rule that "an empty extraction is a
 * FAILURE, not a vacuous pass".
 *
 * The load-bearing assertion is the LAST one in the first block: for all five grades,
 * `opening + SUM(flec_delta)` equals the count the tab itself prints in its header block.
 * That number is computed by Renzo's own formulas from cells this extractor never reads,
 * so agreeing with it is an independent check, not a tautology.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkbook, type LoadedSheet, type LoadedWorkbook } from "../../src/lib/xlsx.js";
import { extractProducts, parseAsOfDate, parseThresholds } from "../../src/reports/products/extract.js";
import { classifyProducts, RENAME_HASH_OVERLAP, type DbProductGrade } from "../../src/reports/products/classify.js";
import { applyProducts } from "../../src/reports/products/apply.js";
import {
  buildFingerprintPayload,
  canonicalProductToken,
  productGradeFingerprint,
  productRowHash,
} from "../../src/lib/productFingerprint.js";
import { productsSheetId, PRODUCTS_SHEET_ID_DEFAULT } from "../../src/reports/products/download.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../fixtures/products-inventory-2026-09-07.xlsx");

async function realExtract() {
  return extractProducts(await loadWorkbook(readFileSync(FIXTURE)));
}

/**
 * The five tabs, their movement counts, and — the point of the whole exercise — the
 * per-stage balance the TAB ITSELF prints in its header block. Read off the live sheet
 * on 2026-09-07.
 */
const EXPECTED = [
  { sheet: "8X50", code: "8X50", moves: 33, headerRow: 12, balances: { FINAL: 59 } },
  { sheet: "6X50", code: "6X50", moves: 331, headerRow: 12, balances: { PROD: 157, AYAG: 3, MAGNET: 25, FINAL: 187 } },
  { sheet: "2X6", code: "2X6", moves: 216, headerRow: 12, balances: { FINAL: 65, BLENDED: 20 } },
  { sheet: "Kuraray 3x50", code: "KURARAY 3X50", moves: 127, headerRow: 13, balances: { "OLD PROD": 110, FINAL: 36 } },
  { sheet: "4X8", code: "4X8", moves: 101, headerRow: 12, balances: { FINAL: 35 } },
] as const;

describe("products — extraction against the real workbook", () => {
  it("reads all five tabs, none unreadable, 808 movements", async () => {
    const ex = await realExtract();
    expect(ex.unreadable_tabs).toEqual([]);
    expect(ex.readable_tabs).toEqual(["8X50", "6X50", "2X6", "Kuraray 3x50", "4X8"]);
    expect(ex.grades).toHaveLength(5);
    expect(ex.total_rows).toBe(808);
  });

  it("finds the DATE header row instead of assuming it (Kuraray is row 13, the rest 12)", async () => {
    const ex = await realExtract();
    for (const want of EXPECTED) {
      const g = ex.grades.find((x) => x.sheet_name === want.sheet)!;
      expect(g, want.sheet).toBeDefined();
      expect(g.header_row, want.sheet).toBe(want.headerRow);
      expect(g.code, want.sheet).toBe(want.code);
      expect(g.movements.length, want.sheet).toBe(want.moves);
    }
  });

  it("reads stage columns from the header row's labels — Kuraray's block is shifted by OLD PROD", async () => {
    const ex = await realExtract();
    const k = ex.grades.find((g) => g.code === "KURARAY 3X50")!;
    expect(k.stages).toEqual(["PROD", "OLD PROD", "AYAG", "MAGNET", "FINAL", "BLENDED", "SUNDRY", "RECLASS"]);
    const other = ex.grades.find((g) => g.code === "8X50")!;
    expect(other.stages).toEqual(["PROD", "AYAG", "MAGNET", "FINAL", "BLENDED", "SUNDRY", "RECLASS"]);
  });

  it("carries the date forward — most rows on four of the five tabs state none", async () => {
    const ex = await realExtract();
    // Every emitted movement has a real date, and no date is ever fabricated as blank.
    for (const g of ex.grades) {
      for (const m of g.movements) {
        expect(m.transaction_date, `${g.code} row ${m.source_row}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    // Kuraray states a DATE on only 34 of its 127 rows; the other 93 inherit it. If the
    // carry-forward regressed, this grade would lose three quarters of its ledger.
    const k = ex.grades.find((g) => g.code === "KURARAY 3X50")!;
    expect(k.movements.length).toBe(127);
    expect(new Set(k.movements.map((m) => m.transaction_date)).size).toBeLessThan(k.movements.length);
  });

  it("kg is NULL, never 0, on the one row that states none", async () => {
    const ex = await realExtract();
    const missing = ex.grades.flatMap((g) =>
      g.movements.filter((m) => m.kg_delta == null).map((m) => ({ code: g.code, ...m })),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].code).toBe("6X50");
    expect(missing[0].transaction_date).toBe("2025-10-03");
    expect(missing[0].stage).toBe("AYAG");
    expect(missing[0].flec_delta).toBe(2);
    expect(missing[0].kg_delta).toBeNull();
  });

  it("parses the thresholds tolerantly — TRESHOLD, THRESHOLD, and none at all", async () => {
    const ex = await realExtract();
    const by = Object.fromEntries(ex.grades.map((g) => [g.code, g.thresholds]));
    expect(by["8X50"]).toEqual({});
    expect(by["6X50"]).toEqual({ ash_max: 1.7, me50_under: 2 });
    expect(by["2X6"]).toEqual({ ash_max: 1.5, me50_under: 2 });
    expect(by["KURARAY 3X50"]).toEqual({ ash_max: 2, me50_under: 2 });
    expect(by["4X8"]).toEqual({ ash_max: 1.5, me50_under: 3, vm_max: 15 });
  });

  it("reads the opening balances and the AS OF date where the tab states one", async () => {
    const ex = await realExtract();
    const by = Object.fromEntries(ex.grades.map((g) => [g.code, g]));
    expect(by["8X50"].openings).toEqual([
      { stage: "PROD", flecs: 32 },
      { stage: "FINAL", flecs: 147 },
    ]);
    expect(by["8X50"].opening_as_of).toBe("2025-08-30");
    // Two tabs state no AS OF date at all. NULL, never a guessed date.
    expect(by["KURARAY 3X50"].opening_as_of).toBeNull();
    expect(by["4X8"].opening_as_of).toBeNull();
    expect(by["4X8"].openings).toEqual([]);
  });

  it("extracts with ZERO warnings on the real sheet", async () => {
    const ex = await realExtract();
    for (const g of ex.grades) expect(g.warnings, g.code).toEqual([]);
  });

  it("PROVES the arithmetic: opening + SUM(flec_delta) equals the tab's OWN header count", async () => {
    const ex = await realExtract();
    for (const want of EXPECTED) {
      const g = ex.grades.find((x) => x.sheet_name === want.sheet)!;
      const bal: Record<string, number> = {};
      for (const o of g.openings) bal[o.stage] = o.flecs;
      for (const m of g.movements) bal[m.stage] = (bal[m.stage] ?? 0) + m.flec_delta;
      for (const stage of g.stages) {
        const computed = bal[stage] ?? 0;
        // The tab leaves a zero stage BLANK; blank and 0 are the same balance here.
        const printed = g.header_counts[stage] ?? 0;
        expect(computed, `${want.sheet} / ${stage}`).toBe(printed);
      }
      // …and the non-zero ones are exactly the numbers read off the live sheet.
      for (const [stage, expected] of Object.entries(want.balances)) {
        expect(bal[stage] ?? 0, `${want.sheet} / ${stage}`).toBe(expected);
      }
    }
  });
});

describe("products — the fingerprint agrees with SQL", () => {
  /**
   * THE DIFFERENTIAL PROOF. These three hexes were READ OUT OF THE LIVE DATABASE by
   * calling `public.fn_product_grade_fingerprint(...)` on 2026-09-07 — they are not this
   * implementation's own output written down. If the TS canonical string and the SQL one
   * ever drift (a sort-order change, a null rendered as 0, a numeric with a trailing
   * zero), exactly one of the two moves and this fails.
   */
  it("reproduces the three hexes computed by fn_product_grade_fingerprint", () => {
    expect(
      productGradeFingerprint({
        v: 1,
        openings: [
          { stage: "FINAL", flecs: 147 },
          { stage: "PROD", flecs: 32 },
        ],
        rows: [
          { d: "2025-09-01", s: "PROD", f: 10, kg: 5500 },
          { d: "2025-09-01", s: "PROD", f: -8, kg: -4400 },
        ],
      }),
    ).toBe("86f14bd42c31b396922e16e9cf3c9cd4d79c732962899d4cf36aabd8ffefe638");

    expect(productGradeFingerprint({ v: 1, openings: [], rows: [] })).toBe(
      "3bfc269594ef649228e9a74bab00f042efc91d5acc6fbee31a382e80d42388fe",
    );

    // The NULL-kg row: hashed as an EMPTY field, never as 0.
    expect(
      productGradeFingerprint({
        v: 1,
        openings: [{ stage: "AYAG", flecs: 2 }],
        rows: [{ d: "2025-10-03", s: "AYAG", f: 2, kg: null }],
      }),
    ).toBe("35c0e524a1a8e1a517974482f070be0be93c2920e0a8f8c6ad5c009044beaacf");
  });

  it("a NULL kg and a ZERO kg are different fingerprints", () => {
    const nul = productGradeFingerprint({ v: 1, openings: [], rows: [{ d: "2025-10-03", s: "AYAG", f: 2, kg: null }] });
    const zero = productGradeFingerprint({ v: 1, openings: [], rows: [{ d: "2025-10-03", s: "AYAG", f: 2, kg: 0 }] });
    expect(nul).not.toBe(zero);
  });

  it("sorts openings so the same tab always hashes the same, whatever order it was read in", () => {
    const a = buildFingerprintPayload(
      [
        { stage: "PROD", flecs: 32 },
        { stage: "FINAL", flecs: 147 },
      ],
      [],
    );
    const b = buildFingerprintPayload(
      [
        { stage: "FINAL", flecs: 147 },
        { stage: "PROD", flecs: 32 },
      ],
      [],
    );
    expect(productGradeFingerprint(a)).toBe(productGradeFingerprint(b));
  });

  it("reads only the first ten rows, so a tab's fingerprint does not move as it grows", async () => {
    const ex = await realExtract();
    const g = ex.grades.find((x) => x.code === "6X50")!;
    const rows = g.movements.map((m) => ({ d: m.transaction_date, s: m.stage, f: m.flec_delta, kg: m.kg_delta }));
    const today = productGradeFingerprint(buildFingerprintPayload(g.openings, rows));
    const tomorrow = productGradeFingerprint(
      buildFingerprintPayload(g.openings, [...rows, { d: "2026-09-30", s: "PROD", f: 9, kg: 5130 }]),
    );
    expect(tomorrow).toBe(today);
  });

  it("the row hash includes the source row, so two identical movements stay two rows", () => {
    const base = {
      date: "2026-09-01",
      stage: "PROD",
      flecDelta: -1,
      kgDelta: -550,
      remarks: "RESIKO FROM SUNDRY",
    };
    expect(productRowHash({ ...base, sourceRow: 39 })).not.toBe(productRowHash({ ...base, sourceRow: 41 }));
  });

  it("the row hash does NOT depend on the grade, so a rename rewrites nothing", () => {
    // With the grade code in the hash, renaming a tab changed all 127 of Kuraray's hashes
    // — the whole ledger was deleted and re-inserted, and rung 2 of the rename ladder
    // could never fire because the two sides were hashed under different names.
    const row = {
      date: "2026-04-06",
      stage: "OLD PROD",
      flecDelta: -1,
      kgDelta: -590,
      remarks: "OLD STOCK/ BLEND WITH",
      sourceRow: 28,
    };
    expect(productRowHash(row)).toBe(productRowHash({ ...row }));
    expect(productRowHash(row)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("canonicalises a tab name the way the DB CHECK constraint requires", () => {
    expect(canonicalProductToken("Kuraray 3x50")).toBe("KURARAY 3X50");
    expect(canonicalProductToken("  8X50  ")).toBe("8X50");
    expect(canonicalProductToken("OLD   PROD")).toBe("OLD PROD");
  });

  it("parses the AS OF date through the ONE month table", () => {
    expect(parseAsOfDate("AS OF AUGUST 30, 2025")).toBe("2025-08-30");
    expect(parseAsOfDate("as of Sept. 1 2026")).toBe("2026-09-01");
    expect(parseAsOfDate("nothing here")).toBeNull();
  });

  it("threshold parsing is tolerant of the sheet's two spellings and demands neither", () => {
    expect(parseThresholds(["ASH TRESHOLD : 1.7"])).toEqual({ ash_max: 1.7 });
    expect(parseThresholds(["ASH THRESHOLD : 1.5"])).toEqual({ ash_max: 1.5 });
    expect(parseThresholds(["VM : 15 MAX"])).toEqual({ vm_max: 15 });
    expect(parseThresholds([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Classification — the rename ladder
// ---------------------------------------------------------------------------

/** Build the DB window the classifier would see AFTER a clean first ingestion. */
async function dbWindowFromExtract(renames: Record<string, string> = {}) {
  const ex = await realExtract();
  const grades: DbProductGrade[] = [];
  const hashesByGrade: Record<string, string[]> = {};
  for (const [i, g] of ex.grades.entries()) {
    const id = `id-${i}`;
    const sheetName = renames[g.code] ?? g.sheet_name;
    grades.push({
      id,
      code: canonicalProductToken(sheetName),
      sheet_name: sheetName,
      content_fingerprint: productGradeFingerprint(
        buildFingerprintPayload(
          g.openings,
          g.movements.map((m) => ({ d: m.transaction_date, s: m.stage, f: m.flec_delta, kg: m.kg_delta })),
        ),
      ),
      active: true,
    });
    hashesByGrade[id] = g.movements.map((m) =>
      productRowHash({
        date: m.transaction_date,
        stage: m.stage,
        flecDelta: m.flec_delta,
        kgDelta: m.kg_delta,
        remarks: m.remarks,
        sourceRow: m.source_row,
      }),
    );
  }
  return { ex, db: { grades, hashesByGrade } };
}

describe("products — classification", () => {
  it("a first run sees five NEW grades and nothing else", async () => {
    const ex = await realExtract();
    const c = classifyProducts(ex, { grades: [], hashesByGrade: {} });
    expect(c.summary.new_count).toBe(5);
    expect(c.summary.rename_count).toBe(0);
    expect(c.summary.missing_count).toBe(0);
    expect(c.summary.to_insert).toBe(808);
    expect(c.summary.to_delete).toBe(0);
  });

  it("an UNCHANGED second run sees five unchanged grades and nothing to write", async () => {
    const { ex, db } = await dbWindowFromExtract();
    const c = classifyProducts(ex, db);
    expect(c.summary.unchanged_count).toBe(5);
    expect(c.summary.changed_count).toBe(0);
    expect(c.summary.new_count).toBe(0);
    expect(c.summary.to_insert).toBe(0);
    expect(c.summary.to_delete).toBe(0);
  });

  it("RENAME rung 1: a tab renamed with its content untouched keeps its id", async () => {
    // The DB knows the grade as "Kuraray 3x50"; the workbook now calls it that no longer.
    const { ex, db } = await dbWindowFromExtract();
    const renamed = {
      ...ex,
      grades: ex.grades.map((g) =>
        g.code === "KURARAY 3X50" ? { ...g, sheet_name: "KURARAY 3X50 (2026)", code: "KURARAY 3X50 (2026)" } : g,
      ),
      readable_tabs: ex.readable_tabs.map((t) => (t === "Kuraray 3x50" ? "KURARAY 3X50 (2026)" : t)),
    };
    const c = classifyProducts(renamed, db);
    expect(c.summary.rename_count).toBe(1);
    expect(c.summary.new_count).toBe(0);
    expect(c.summary.missing_count).toBe(0);
    const r = c.grades.find((g) => g.action === "rename")!;
    expect(r.rename_evidence).toBe("fingerprint");
    expect(r.previous_sheet_name).toBe("Kuraray 3x50");
    expect(r.grade_id).toBe(db.grades.find((g) => g.code === "KURARAY 3X50")!.id);
    // Its whole ledger is already filed — a rename writes nothing.
    expect(r.to_insert).toBe(0);
    expect(r.to_delete).toBe(0);
  });

  it("RENAME rung 2: a renamed tab whose OPENING was also edited still matches, on overlap", async () => {
    const { ex, db } = await dbWindowFromExtract();
    // Rename AND change the opening balance — rung 1 (fingerprint) can no longer fire.
    const renamed = {
      ...ex,
      grades: ex.grades.map((g) =>
        g.code === "4X8"
          ? { ...g, sheet_name: "4X8 NEW", code: "4X8 NEW", openings: [{ stage: "FINAL", flecs: 7 }] }
          : g,
      ),
    };
    const c = classifyProducts(renamed, db);
    const r = c.grades.find((g) => g.action === "rename")!;
    expect(r).toBeDefined();
    expect(r.rename_evidence).toBe("row_overlap");
    expect(r.previous_code).toBe("4X8");
    expect(r.rename_overlap).toBeGreaterThanOrEqual(RENAME_HASH_OVERLAP);
    expect(c.summary.missing_count).toBe(0);
  });

  it("a genuinely NEW product is added, not mistaken for a rename", async () => {
    const { ex, db } = await dbWindowFromExtract();
    const withNew = {
      ...ex,
      grades: [
        ...ex.grades,
        {
          ...ex.grades[0],
          sheet_name: "3X50",
          code: "3X50",
          openings: [{ stage: "FINAL", flecs: 4 }],
          movements: ex.grades[0].movements.slice(0, 3).map((m) => ({ ...m, remarks: "BRAND NEW LINE" })),
        },
      ],
    };
    const c = classifyProducts(withNew, db);
    expect(c.summary.new_count).toBe(1);
    expect(c.summary.rename_count).toBe(0);
    expect(c.grades.find((g) => g.code === "3X50")!.action).toBe("new");
  });

  it("a tab that DISAPPEARS is reported missing and nothing is deleted", async () => {
    const { ex, db } = await dbWindowFromExtract();
    const dropped = {
      ...ex,
      grades: ex.grades.filter((g) => g.code !== "8X50"),
      readable_tabs: ex.readable_tabs.filter((t) => t !== "8X50"),
    };
    const c = classifyProducts(dropped, db);
    expect(c.summary.missing_count).toBe(1);
    expect(c.missing[0].code).toBe("8X50");
    expect(c.summary.to_delete).toBe(0);
  });

  it("AMBIGUITY IS REFUSED: two absent grades matching means nothing is renamed", async () => {
    const { ex } = await realExtract().then(async (e) => ({ ex: e }));
    const g = ex.grades.find((x) => x.code === "4X8")!;
    const fp = productGradeFingerprint(
      buildFingerprintPayload(
        g.openings,
        g.movements.map((m) => ({ d: m.transaction_date, s: m.stage, f: m.flec_delta, kg: m.kg_delta })),
      ),
    );
    // Two DB grades, both absent from the workbook, both carrying this exact fingerprint.
    const db = {
      grades: [
        { id: "a", code: "4X8 OLD", sheet_name: "4X8 OLD", content_fingerprint: fp, active: true },
        { id: "b", code: "4X8 ARCHIVE", sheet_name: "4X8 ARCHIVE", content_fingerprint: fp, active: true },
      ],
      hashesByGrade: {},
    };
    const c = classifyProducts({ ...ex, grades: [g] }, db);
    expect(c.summary.rename_count).toBe(0);
    expect(c.summary.new_count).toBe(1);
    expect(c.grades[0].ambiguous_candidates).toEqual(["4X8 OLD", "4X8 ARCHIVE"]);
    // Both survive, both flagged — nothing was merged and nothing was lost.
    expect(c.summary.missing_count).toBe(2);
  });

  it("a grade whose tab is STILL PRESENT can never be the source of a rename", async () => {
    const { ex, db } = await dbWindowFromExtract();
    // A second tab with 8X50's exact content, while 8X50 itself is still in the workbook.
    const twin = { ...ex.grades[0], sheet_name: "8X50 COPY", code: "8X50 COPY" };
    const c = classifyProducts({ ...ex, grades: [...ex.grades, twin] }, db);
    expect(c.grades.find((g) => g.code === "8X50 COPY")!.action).toBe("new");
    expect(c.summary.rename_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unreadable tabs (L-048)
// ---------------------------------------------------------------------------

/** A minimal in-memory workbook — no fixture file needed to prove a tab is unreadable. */
function fakeWorkbook(sheets: Record<string, Array<Array<string | number | null>>>): LoadedWorkbook {
  const make = (name: string, rows: Array<Array<string | number | null>>): LoadedSheet => ({
    name,
    rowCount: rows.length,
    columnCount: Math.max(1, ...rows.map((r) => r.length)),
    cell: (row: number, col: number) => (rows[row - 1]?.[col - 1] ?? null) as never,
  });
  const names = Object.keys(sheets);
  return {
    sheetNames: names,
    sheet: (n: string) => (sheets[n] ? make(n, sheets[n]) : null),
    sheetAt: (i: number) => (names[i] ? make(names[i], sheets[names[i]]) : null),
  };
}

describe("products — a tab it cannot read is named, never silently skipped (L-048)", () => {
  it("a tab with no DATE header row is reported unreadable", () => {
    const ex = extractProducts(
      fakeWorkbook({
        "MYSTERY TAB": [["SOMETHING INVENTORY"], ["not", "a", "ledger"]],
      }),
    );
    expect(ex.grades).toHaveLength(0);
    expect(ex.unreadable_tabs).toEqual(["MYSTERY TAB"]);
    expect(ex.readable_tabs).toEqual([]);
    expect(ex.total_rows).toBe(0);
  });

  it("a tab with a DATE row but NO stage columns is unreadable, not an empty grade", () => {
    const ex = extractProducts(
      fakeWorkbook({
        "HALF A TAB": [["X INVENTORY"], ["DATE", "TYPE", "FLEC / SKS", "KG", "REMARKS"]],
      }),
    );
    expect(ex.unreadable_tabs).toEqual(["HALF A TAB"]);
  });

  it("one bad tab beside a good one is a PARTIAL miss — the good tab still ingests", () => {
    const ex = extractProducts(
      fakeWorkbook({
        BROKEN: [["nothing"]],
        GOOD: [
          ["GOOD INVENTORY"],
          ["DATE", "TYPE", "FLEC / SKS", "KG", "REMARKS", "PROD", "FINAL"],
          ["2026-01-01", "PROD", 5, 2750, null, 5, 0],
        ],
      }),
    );
    expect(ex.readable_tabs).toEqual(["GOOD"]);
    expect(ex.unreadable_tabs).toEqual(["BROKEN"]);
    expect(ex.grades).toHaveLength(1);
    // TWO warnings, both correct and both loud: the stub tab has no FLECON STARTING
    // BALANCE row, and its date cell is a STRING rather than a date, so that row cannot be
    // dated and is refused rather than filed under a guess.
    expect(ex.grades[0].warnings).toHaveLength(2);
    expect(ex.grades[0].warnings.join(" ")).toMatch(/STARTING BALANCE/);
    expect(ex.grades[0].warnings.join(" ")).toMatch(/not a date/);
    expect(ex.grades[0].movements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Apply — idempotence
// ---------------------------------------------------------------------------

/** A stub that reproduces `fn_replace_product_grade`'s row_hash semantics in memory. */
function stubDb(existing: Record<string, Set<string>> = {}) {
  const calls: string[] = [];
  const store: Record<string, Set<string>> = { ...existing };
  let nextId = 1;
  const idByCode: Record<string, string> = {};
  return {
    calls,
    store,
    db: {
      async upsertProductGrade(a: { sheetName: string }) {
        const code = canonicalProductToken(a.sheetName);
        const created = idByCode[code] === undefined;
        idByCode[code] ??= `g${nextId++}`;
        calls.push(`upsert:${code}`);
        return { ok: true, gradeId: idByCode[code], code, created };
      },
      async renameProductGrade(gradeId: string, newSheetName: string) {
        calls.push(`rename:${gradeId}->${canonicalProductToken(newSheetName)}`);
        idByCode[canonicalProductToken(newSheetName)] = gradeId;
        return { ok: true, renamed: true };
      },
      async replaceProductGrade(
        gradeId: string,
        _openings: Array<Record<string, unknown>>,
        movements: Array<Record<string, unknown>>,
      ) {
        const have = (store[gradeId] ??= new Set());
        const incoming = new Set(movements.map((m) => String(m.row_hash)));
        const inserted = [...incoming].filter((h) => !have.has(h)).length;
        const deleted = [...have].filter((h) => !incoming.has(h)).length;
        store[gradeId] = incoming;
        calls.push(`replace:${gradeId}:+${inserted}/-${deleted}`);
        return { ok: true, inserted, deleted, unchanged: incoming.size - inserted };
      },
      async writeIngestionAudit(a: { comment: string }) {
        calls.push(`audit:${a.comment.slice(0, 24)}`);
        return { id: "audit" };
      },
      async upsertIngestionWatermark(rt: string) {
        calls.push(`watermark:${rt}`);
        return true;
      },
    },
  };
}

describe("products — apply is idempotent", () => {
  it("the FIRST run writes 808 movements; the SECOND writes nothing at all", async () => {
    const ex = await realExtract();
    const s = stubDb();

    const first = await applyProducts(classifyProducts(ex, { grades: [], hashesByGrade: {} }), { db: s.db });
    expect(first.ok).toBe(true);
    expect(first.errors).toEqual([]);
    expect(first.applied.inserts).toBe(808);
    expect(first.deleted).toBe(0);
    expect(first.grades_created).toBe(5);
    expect(first.watermark_updated).toBe(true);
    expect(first.product_notes.filter((n) => n.kind === "product_grade_added")).toHaveLength(5);

    // Re-run the identical sheet against the state the first run left behind.
    const dbGrades: DbProductGrade[] = ex.grades.map((g, i) => ({
      id: `g${i + 1}`,
      code: g.code,
      sheet_name: g.sheet_name,
      content_fingerprint: null,
      active: true,
    }));
    const hashesByGrade = Object.fromEntries(
      Object.entries(s.store).map(([id, set]) => [id, [...set]]),
    );
    const second = await applyProducts(classifyProducts(ex, { grades: dbGrades, hashesByGrade }), { db: s.db });
    expect(second.applied.inserts).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.grades_created).toBe(0);
    expect(second.grades_renamed).toBe(0);
    expect(second.product_notes).toEqual([]);
    // …and NOT ONE audit row: an unchanged sheet must leave no trace in the trail.
    expect(s.calls.filter((c) => c.startsWith("audit:"))).toHaveLength(5);
  });

  it("a missing tab produces a note and NO delete", async () => {
    const ex = await realExtract();
    const c = classifyProducts({ ...ex, grades: ex.grades.slice(1) }, {
      grades: [{ id: "old-8x50", code: "8X50", sheet_name: "8X50", content_fingerprint: null, active: true }],
      hashesByGrade: { "old-8x50": ["deadbeef"] },
    });
    const s = stubDb();
    const r = await applyProducts(c, { db: s.db });
    expect(r.product_notes.some((n) => n.kind === "product_sheet_missing" && n.code === "8X50")).toBe(true);
    expect(s.calls.some((call) => call.startsWith("replace:old-8x50"))).toBe(false);
  });
});

describe("products — the sheet id", () => {
  it("defaults to the committed id and honours PRODUCTS_SHEET_ID", () => {
    expect(productsSheetId({} as NodeJS.ProcessEnv)).toBe(PRODUCTS_SHEET_ID_DEFAULT);
    expect(productsSheetId({ PRODUCTS_SHEET_ID: "  " } as NodeJS.ProcessEnv)).toBe(PRODUCTS_SHEET_ID_DEFAULT);
    expect(productsSheetId({ PRODUCTS_SHEET_ID: "OTHER" } as NodeJS.ProcessEnv)).toBe("OTHER");
  });
});
