/**
 * rc_movement_audit.test.ts — unit tests for the rc_movement_audit port (Wave 3, port #6).
 *
 * The parity harness (`npm run parity -- --type rc_movement_audit`) is the primary gate;
 * these tests lock the drift-classification math that IS the point of this read-only
 * watchdog:
 *   - drift severity boundaries: 49.99 (clean) / 50 (clean, strict >) / 50.01 (warning) /
 *     500 (warning, strict >) / 500.01 (serious), for P-vs-M and the O-vs-M duplication gate.
 *   - the "No RC MOVEMENT entry for this date" note when a PROPOSED date has no movement.
 *   - the L-019 rule: O ABOVE M trips; O BELOW M is silent.
 *   - L-022 cross-month summing in the extractor (a date on two tabs sums, never overwrites).
 *   - the synthetic-proposed-from-rc_out-sums trick: P == O ⇒ drift_p_vs_o == 0 everywhere.
 *
 * Ground truth: reconcile_rc_movement.py, extract_rc_movement.py, audit_rc_movement.py.
 */
import { describe, it, expect } from "vitest";

import { reconcile } from "../../src/reports/rc_movement_audit/reconcile.js";
import { extractMovement } from "../../src/reports/rc_movement_audit/extract.js";
import type { LoadedWorkbook, LoadedSheet, CellValue } from "../../src/lib/xlsx.js";

// ---------------------------------------------------------------------------
// Helpers: run reconcile for a single (P, M, O) triple mirroring the auditor's
// double-feed (proposed built FROM the sums map, sums passed as the O input).
// ---------------------------------------------------------------------------
const D = "2026-07-04";

/** Auditor-shaped run: P == O == `o`, M == `m`. Returns the single date's entry + severity. */
function runAudit(o: number, m: number) {
  const sums = { [D]: o };
  const proposed = { rows: [{ transaction_date: D, weight_kg: o }] };
  const rep = reconcile(proposed, { date_to_fed_kls: { [D]: m } }, sums, 50, 500);
  const entry = [...rep.drift_dates, ...rep.ok_dates].find((e) => e.date === D)!;
  return { rep, entry };
}

// ---------------------------------------------------------------------------
// Drift boundaries — P-vs-M and O-vs-M share the SAME numbers here (P == O), so a
// positive O-M excess and the P-M drift are equal. Thresholds are STRICT `>`.
// ---------------------------------------------------------------------------
describe("drift severity boundaries (strict >, tolerance 50 / serious 500)", () => {
  it("|drift| = 49.99 (< 50) → clean, no notes, severity 0", () => {
    const { rep, entry } = runAudit(1049.99, 1000);
    expect(entry.notes).toEqual([]);
    expect(rep.severity).toBe(0);
    expect(rep.ok_dates).toHaveLength(1);
    expect(entry.drift_p_vs_m_kg).toBe(49.99);
    expect(entry.excess_o_vs_m_kg).toBe(49.99);
  });

  it("drift = exactly 50 → clean (strict >, 50 does NOT trip), severity 0", () => {
    const { rep, entry } = runAudit(1050, 1000);
    expect(entry.notes).toEqual([]);
    expect(rep.severity).toBe(0);
  });

  it("drift = 50.01 (> 50, ≤ 500) → warning (severity 1), both P-vs-M + O-vs-M notes", () => {
    const { rep, entry } = runAudit(1050.01, 1000);
    expect(rep.severity).toBe(1);
    expect(entry.notes).toContain("Tolerable drift PROPOSED vs RC MOVEMENT: +50 kg");
    expect(entry.notes).toContain(
      "DB rc_out SUM above RC MOVEMENT by +50 kg (possible partial duplication) — review.",
    );
    expect(rep.drift_dates).toHaveLength(1);
  });

  it("drift = exactly 500 → warning (strict >, 500 does NOT trip serious), severity 1", () => {
    const { rep, entry } = runAudit(1500, 1000);
    expect(rep.severity).toBe(1);
    expect(entry.notes.some((n) => n.startsWith("Tolerable drift"))).toBe(true);
    expect(entry.notes.some((n) => n.startsWith("SERIOUS"))).toBe(false);
  });

  it("drift = 500.01 (> 500) → serious (severity 2), both SERIOUS notes fire", () => {
    const { rep, entry } = runAudit(1500.01, 1000);
    expect(rep.severity).toBe(2);
    expect(entry.notes).toContain("SERIOUS drift PROPOSED vs RC MOVEMENT: +500 kg");
    expect(
      entry.notes.some(
        (n) =>
          n.startsWith("SERIOUS DB-side DUPLICATION") &&
          n.includes("(O=1500 > M=1000)") &&
          // the em-dash (U+2014) must be verbatim
          n.includes("— do NOT write"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L-019: O ABOVE M trips; O BELOW M is completely silent (continuous-flow lag is normal).
// ---------------------------------------------------------------------------
describe("L-019 duplication gate — only a positive O-M excess trips", () => {
  it("O far BELOW M (O-M = -5000) → silent: no duplication note, severity 0", () => {
    const { rep, entry } = runAudit(1000, 6000);
    // P-vs-M drift is -5000 → SERIOUS on the P-vs-M axis (abs > 500), but the O-vs-M
    // duplication note must NOT fire (excess is negative).
    expect(entry.notes.some((n) => n.includes("DB-side DUPLICATION"))).toBe(false);
    expect(entry.notes.some((n) => n.includes("possible partial duplication"))).toBe(false);
    // The excess field is still computed (round(O - M, 2)) but negative.
    expect(entry.excess_o_vs_m_kg).toBe(-5000);
    // severity is driven by the P-vs-M axis here.
    expect(rep.severity).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Missing-movement-date note — a PROPOSED/rc_out date the movement sheet lacks.
// ---------------------------------------------------------------------------
describe("missing RC MOVEMENT entry", () => {
  it("P present, M absent → 'No RC MOVEMENT entry for this date'; excess null; p-vs-o 0", () => {
    const sums = { [D]: 34153 };
    const proposed = { rows: [{ transaction_date: D, weight_kg: 34153 }] };
    // movement has NO entry for D.
    const rep = reconcile(proposed, { date_to_fed_kls: {} }, sums, 50, 500);
    const entry = rep.drift_dates.find((e) => e.date === D)!;
    expect(entry.notes).toEqual(["No RC MOVEMENT entry for this date"]);
    expect(entry.rc_movement_kg).toBeNull();
    expect(entry.drift_p_vs_m_kg).toBeNull();
    expect(entry.excess_o_vs_m_kg).toBeNull(); // O present but M null → gate skipped
    expect(entry.drift_p_vs_o_kg).toBe(0); // P == O by the synthetic-proposed trick
    // "No RC MOVEMENT entry" is a NOTE (lands in drift_dates) but bumps NO severity.
    expect(rep.severity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Date-universe walk — a movement-only date (no PROPOSED, no rc_out) is INVISIBLE.
// ---------------------------------------------------------------------------
describe("date universe = PROPOSED ∪ rc_out_sums (movement-only date invisible)", () => {
  it("a date only in the movement sheet never appears in drift_dates or ok_dates", () => {
    const sums = { "2026-07-01": 30000 };
    const proposed = { rows: [{ transaction_date: "2026-07-01", weight_kg: 30000 }] };
    const rep = reconcile(
      proposed,
      { date_to_fed_kls: { "2026-07-01": 30000, "2099-01-01": 12345 } },
      sums,
      50,
      500,
    );
    const allDates = [...rep.drift_dates, ...rep.ok_dates].map((e) => e.date);
    expect(allDates).toContain("2026-07-01");
    expect(allDates).not.toContain("2099-01-01"); // movement-only → invisible
    expect(rep.summary.total_dates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// L-022 cross-month summing — a boundary date on TWO tabs sums, never overwrites.
// ---------------------------------------------------------------------------
describe("extractMovement L-022 cross-month summing", () => {
  it("a date appearing on two month-tabs is SUMMED (round 2dp), not overwritten", () => {
    // Two tabs, each with a DATE header at row 1 and data at row 4 (header_row + 3).
    // The MAY tab carries 21810 for 2026-05-29; the JUNE tab carries 5000 for the same
    // date (a carryover). The extractor must sum to 26810, not keep the last-seen 5000.
    const wb = mkWorkbook([
      { name: "MAY 2026", rows: rowsFor("2026-05-29", 21810) },
      { name: "JUNE 2026", rows: rowsFor("2026-05-29", 5000) },
    ]);
    const ex = extractMovement(wb);
    expect(ex.date_to_fed_kls["2026-05-29"]).toBe(26810);
    expect(ex.rows).toHaveLength(2); // both source rows preserved
  });

  it("distinct dates on separate tabs stay independent", () => {
    const wb = mkWorkbook([
      { name: "MAY 2026", rows: rowsFor("2026-05-28", 40000) },
      { name: "JUNE 2026", rows: rowsFor("2026-06-01", 34705) },
    ]);
    const ex = extractMovement(wb);
    expect(ex.date_to_fed_kls).toEqual({ "2026-05-28": 40000, "2026-06-01": 34705 });
  });

  it("a section-break token (e.g. TOTAL) in col A STOPS the scan for that sheet", () => {
    // Row 4 = a valid date; row 5 = 'TOTAL' (break); row 6 = another date that must be IGNORED.
    const rows: Record<string, CellValue>[] = [
      { A: "DATE", B: null }, // header @ r1
      { A: null, B: null }, // r2
      { A: null, B: null }, // r3
      { A: "2026-05-25", B: 35145 }, // r4 data
      { A: "TOTAL", B: 999999 }, // r5 section break → stop
      { A: "2026-05-26", B: 45167 }, // r6 must NOT be read
    ];
    const wb = mkWorkbook([{ name: "MAY 2026", rows }]);
    const ex = extractMovement(wb);
    expect(ex.date_to_fed_kls).toEqual({ "2026-05-25": 35145 });
  });

  it("a date row with an empty fed total (col B) is skipped", () => {
    const rows: Record<string, CellValue>[] = [
      { A: "DATE", B: null },
      { A: null, B: null },
      { A: null, B: null },
      { A: "2026-05-25", B: null }, // fed empty → skipped
      { A: "2026-05-26", B: 45167 },
    ];
    const wb = mkWorkbook([{ name: "MAY 2026", rows }]);
    const ex = extractMovement(wb);
    expect(ex.date_to_fed_kls).toEqual({ "2026-05-26": 45167 });
  });
});

// ---------------------------------------------------------------------------
// Tiny in-memory LoadedWorkbook builder (col letters A/B → 1/2).
// ---------------------------------------------------------------------------
interface SheetSpec {
  name: string;
  rows: Record<string, CellValue>[]; // 1-based row index; keys are column letters "A".."Z"
}

/** rows for a single DATE header (r1) + 2 blank sub-rows (r2,r3) + one data row (r4). */
function rowsFor(date: string, fed: number): Record<string, CellValue>[] {
  return [
    { A: "DATE", B: null },
    { A: null, B: null },
    { A: null, B: null },
    { A: date, B: fed },
  ];
}

function colLetterToIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n; // A → 1
}

function mkWorkbook(specs: SheetSpec[]): LoadedWorkbook {
  const sheets = new Map<string, LoadedSheet>();
  for (const spec of specs) {
    const maxCol = spec.rows.reduce((mx, row) => {
      for (const k of Object.keys(row)) mx = Math.max(mx, colLetterToIndex(k));
      return mx;
    }, 1);
    const sheet: LoadedSheet = {
      name: spec.name,
      rowCount: spec.rows.length,
      columnCount: maxCol,
      cell(row: number, col: number): CellValue {
        const r = spec.rows[row - 1];
        if (!r) return null;
        // find the column letter for this 1-based index
        for (const [letter, val] of Object.entries(r)) {
          if (colLetterToIndex(letter) === col) return val;
        }
        return null;
      },
    };
    sheets.set(spec.name, sheet);
  }
  const names = specs.map((s) => s.name);
  return {
    sheetNames: names,
    sheet: (name: string) => sheets.get(name) ?? null,
    sheetAt: (i: number) => (names[i] ? (sheets.get(names[i]) ?? null) : null),
  };
}
