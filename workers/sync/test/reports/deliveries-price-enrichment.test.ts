/**
 * deliveries-price-enrichment.test.ts — the regression suite for the 2026-08-07
 * price-enrichment failure, run against the REAL Czarina workbook.
 *
 * ============================================================================
 * WHAT BROKE, AND WHAT EACH BLOCK HERE GUARDS
 * ============================================================================
 * The sync had priced ZERO August 2026 deliveries. Nine truckloads carried
 * `cost_basis = 0` for a week and dragged AUGUST-26-BLK1's average cost to ₱11.01
 * against a real ₱39.99. Four independent faults:
 *
 *   (a) TAB NAME. The worker built Czarina's tab name as `"<FullMonth> <YYYY>"` →
 *       "August 2026" and looked it up by EXACT match. Her tab is "Aug. 2026".
 *   (b) SILENT WHOLE-FILE FAILURE. The miss threw, and a bare `catch` reported
 *       "Price file unavailable — proceeding without prices." The file WAS
 *       available. The price file loads ONCE before the row loop, so one bad tab
 *       name un-priced the ENTIRE run.
 *   (c) ONE MONTH ONLY. Only the newest month in the window was loaded, so a run
 *       crossing a month boundary silently left the earlier month unpriced.
 *   (d) SUPPLIER VARIANTS. "Paquibot/Compra" (ours) never keyed equal to
 *       "PAQUIBOT" (hers).
 *
 * Every test below is built from REAL data: the workbook is the actual file
 * attached to the 2026-08-07 report, and the ten delivery rows are the exact
 * values read back out of `public.deliveries` after Renzo's confirmed backfill.
 * That matters — a synthetic fixture cannot prove the resolver copes with 24 tabs
 * a human named by hand over two years.
 *
 * If the workbook is absent (a fresh clone has no `.sync-flags/`), the
 * workbook-dependent blocks SKIP rather than fail; the pure-logic blocks always run.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import {
  monthsSpanned,
  monthOfISO,
  parseCzarinaTabName,
  parseCzarinaTabs,
  resolveCzarinaTab,
} from "../../src/reports/deliveries/czarinaSheet.js";
import {
  enrichPrices,
  normTruck,
  normWeight,
  platesCorroborate,
  type PriceBand,
  type SourceAlias,
} from "../../src/reports/deliveries/enrich.js";
import { canonicalSupplier } from "../../src/reports/deliveries/supplierCanon.js";
import type { DeliveryRow } from "../../src/reports/deliveries/extract.js";

// ---------------------------------------------------------------------------
// The real workbook + the real tab list read from it on 2026-08-07.
// ---------------------------------------------------------------------------
const CZARINA_XLSX =
  "/Users/renzosy/blackwood/.sync-flags/2026-08-07/124885_RAW CHARCOAL PURCHASES -Daily.xlsx";
const HAVE_WORKBOOK = existsSync(CZARINA_XLSX);

/**
 * Every worksheet name in the real file, verbatim — including the trailing period on
 * "Jan. 2026." and the TRAILING SPACE on "Nov 25. ". Twenty-four tabs, at least four
 * naming conventions: abbreviated/full month, with/without a period, 2-/4-digit year,
 * with/without a space. Exact string matching was never going to hold.
 */
const REAL_TABS = [
  "July.2024", "Oct.24", "Nov.24", "Dec.24", "JAN.2025", "Feb.25", "March25",
  "April 25", "May 25", "June 25", "July 25", "Aug. 25", "Sept. 25",
  "Feb. 2026", "Aug. 2026", "July 2026", "June 2026", "May 2026", "April 2026",
  "March 2026", "Jan. 2026.", "Dec. 25.", "Nov 25. ", "Oct 25.",
] as const;

/** The tab-name generator that CAUSED the bug, kept here only to prove it fails. */
const FULL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function theOldBrokenTabName(year: number, month: number): string {
  return `${FULL_MONTHS[month - 1]} ${year}`;
}

// ---------------------------------------------------------------------------
// The ten deliveries Renzo confirmed and backfilled — real values from the DB.
// `cost_basis: 0` is the state they were in BEFORE the fix (the L-008 placeholder).
// ---------------------------------------------------------------------------
interface Seed {
  date: string;
  supplier: string;
  batch: string;
  block: string;
  plate: string;
  sacks: number;
  kg: number;
  /** The price Renzo confirmed against Czarina's file. */
  want: number;
}

const TEN: Seed[] = [
  { date: "2026-08-05", supplier: "Ornales",         batch: "AUGUST-26-BLK4", block: "A-9B",  plate: "MAV 9202", sacks: 596, kg: 23515, want: 40.5 },
  { date: "2026-08-05", supplier: "Ornales",         batch: "AUGUST-26-BLK1", block: "A-9A",  plate: "KCA 378",  sacks: 506, kg: 17915, want: 40.0 },
  { date: "2026-08-05", supplier: "Ornales",         batch: "AUGUST-26-BLK1", block: "A-9A",  plate: "MDH 272",  sacks: 276, kg: 9755,  want: 40.5 },
  { date: "2026-08-05", supplier: "Paquibot",        batch: "AUGUST-26-BLK2", block: "A-11A", plate: "MAN 3625", sacks: 505, kg: 21430, want: 40.5 },
  { date: "2026-08-05", supplier: "Esito",           batch: "AUGUST-26-BLK3", block: "D-12D", plate: "JDF 981",  sacks: 160, kg: 5340,  want: 39.0 },
  { date: "2026-08-01", supplier: "Ornales",         batch: "JULY-26-BLK13",  block: "C-6B",  plate: "MAV 9202", sacks: 589, kg: 22375, want: 39.5 },
  { date: "2026-08-01", supplier: "Paquibot",        batch: "JULY-26-BLK11",  block: "A-4C",  plate: "AAV 6111", sacks: 473, kg: 18065, want: 40.0 },
  // The three FUZZY rows — each one a different flavour of source disagreement.
  { date: "2026-07-23", supplier: "Ornales",         batch: "JULY-26-BLK9",   block: "C-12B", plate: "T138003",  sacks: 485, kg: 19010, want: 39.5 },
  { date: "2026-07-20", supplier: "Paquibot/Compra", batch: "JULY-26-BLK5",   block: "A-17C", plate: "AAV 6111", sacks: 439, kg: 18695, want: 39.0 },
  { date: "2026-07-02", supplier: "Llanto",          batch: "JULY-26-BLK2",   block: "D-13D", plate: "ALA 3958", sacks: 625, kg: 23930, want: 37.25 },
];

function mkRow(s: Seed, sourceRow = 0): DeliveryRow {
  return {
    transaction_date: s.date,
    supplier: s.supplier,
    batch_code: s.batch,
    operator_batch_label: s.batch,
    block_loc: s.block,
    truck_plate: s.plate,
    sacks: s.sacks,
    weight_kg: s.kg,
    cost_basis: 0, // the L-008 unpriced placeholder — the state before the fix
    remarks: null,
    lab_results: null,
    true_weight_kg: null,
    deduction_note: null,
    warnings: [],
    confidence: 1,
    _source_row: sourceRow,
  };
}

function buf(): Buffer {
  return readFileSync(CZARINA_XLSX);
}

const describeWb = HAVE_WORKBOOK ? describe : describe.skip;

// ===========================================================================
// (a) TAB RESOLUTION — the fault that started it all.
// ===========================================================================
describe("(a) Czarina tab resolution — normalize to (month, year), never exact-match", () => {
  it("PROVES THE BUG: the old generator's name is absent from the real workbook", () => {
    // This is the whole failure in two assertions. "August 2026" and "February 2026"
    // are simply not tab names in her file, and `getWorksheet()` is exact-match.
    expect(REAL_TABS).not.toContain(theOldBrokenTabName(2026, 8)); // "August 2026"
    expect(REAL_TABS).not.toContain(theOldBrokenTabName(2026, 2)); // "February 2026"
    // And this is why nobody noticed for months: March–July 2026 DO match by luck.
    expect(REAL_TABS).toContain(theOldBrokenTabName(2026, 7)); // "July 2026"
    expect(REAL_TABS).toContain(theOldBrokenTabName(2026, 3)); // "March 2026"
  });

  it("finds Aug. 2026, Feb. 2026 and Jan. 2026. from a generated month+year", () => {
    // The three the brief calls out. Note each is a DIFFERENT naming convention:
    // abbreviation+period, abbreviation+period, and a TRAILING period.
    const aug = resolveCzarinaTab(REAL_TABS, 2026, 8);
    expect(aug.ok && aug.tab.name).toBe("Aug. 2026");

    const feb = resolveCzarinaTab(REAL_TABS, 2026, 2);
    expect(feb.ok && feb.tab.name).toBe("Feb. 2026");

    const jan = resolveCzarinaTab(REAL_TABS, 2026, 1);
    expect(jan.ok && jan.tab.name).toBe("Jan. 2026.");
  });

  it("also handles the trailing-space and no-space/2-digit-year conventions", () => {
    // "Nov 25. " has a trailing SPACE after the period — an invisible difference that
    // no amount of careful typing would have caught.
    const nov = resolveCzarinaTab(REAL_TABS, 2025, 11);
    expect(nov.ok && nov.tab.name).toBe("Nov 25. ");
    // "March25" — no separator at all, 2-digit year.
    const mar = resolveCzarinaTab(REAL_TABS, 2025, 3);
    expect(mar.ok && mar.tab.name).toBe("March25");
    // "July.2024" — period as the separator, 4-digit year.
    const jul = resolveCzarinaTab(REAL_TABS, 2024, 7);
    expect(jul.ok && jul.tab.name).toBe("July.2024");
    // "Sept. 25" — the SEPT/SEP asymmetry, owned by lib/months.ts, not redefined here.
    const sep = resolveCzarinaTab(REAL_TABS, 2025, 9);
    expect(sep.ok && sep.tab.name).toBe("Sept. 25");
  });

  it("resolves EVERY one of the 24 real tabs to a distinct month, none dropped", () => {
    const parsed = parseCzarinaTabs(REAL_TABS);
    expect(parsed).toHaveLength(REAL_TABS.length);
    // Every tab must be a UNIQUE month — if two collided, the resolver would be
    // permanently ambiguous for that month and price nothing.
    const keys = new Set(parsed.map((t) => `${t.year}-${t.month}`));
    expect(keys.size).toBe(REAL_TABS.length);
    // And each one round-trips: resolve(its own month) returns that exact tab.
    for (const t of parsed) {
      const r = resolveCzarinaTab(REAL_TABS, t.year, t.month);
      expect(r.ok && r.tab.name).toBe(t.name);
    }
  });

  it("ignores non-month tabs instead of misreading them", () => {
    for (const junk of ["SUMMARY", "Sheet1", "", "2026", "Q1 2026", "Aug 12345", "Notes"]) {
      expect(parseCzarinaTabName(junk)).toBeNull();
    }
  });

  it("REFUSES ambiguity — two tabs meaning the same month is never guessed", () => {
    // The realistic case: someone leaves a working copy called "Aug 2026" next to
    // "Aug. 2026". Picking one would price a whole month from a scratch tab.
    const withDupe = [...REAL_TABS, "Aug 2026"];
    const r = resolveCzarinaTab(withDupe, 2026, 8);
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "ambiguous") throw new Error(`expected ambiguous, got ${JSON.stringify(r)}`);
    expect(r.candidates).toEqual(expect.arrayContaining(["Aug. 2026", "Aug 2026"]));
    expect(r.looked_for).toBe("August 2026");
  });
});

// ===========================================================================
// (c) EVERY MONTH THE WINDOW SPANS.
// ===========================================================================
describe("(c) monthsSpanned — a window crossing a month boundary loads BOTH months", () => {
  it("returns every distinct month, ascending", () => {
    // The real 2026-08-07 window: watermark − 3 days straddles the boundary, and two
    // of the ten backfilled rows are dated 2026-08-01 while three are in July.
    expect(monthsSpanned(TEN.map((s) => s.date))).toEqual([
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
    ]);
  });

  it("the sync window straddles a boundary on the 1st, 2nd and 3rd of EVERY month", () => {
    // watermark 2026-08-02 − 3d = 2026-07-30 → the window touches July AND August.
    expect(monthsSpanned(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"])).toEqual([
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
    ]);
    // …and across a YEAR boundary too.
    expect(monthsSpanned(["2025-12-30", "2026-01-02"])).toEqual([
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
    ]);
  });

  it("is guarded: junk dates are dropped, not turned into a bogus month", () => {
    expect(monthsSpanned([])).toEqual([]);
    expect(monthsSpanned(["", "x", "2026", "2026-13-01", "2026-00-01"])).toEqual([]);
    expect(monthOfISO("2026-08-05")).toEqual({ year: 2026, month: 8 });
  });
});

// ===========================================================================
// (f) PLATE SHAPE — a tie-breaker, never a matcher.
// ===========================================================================
describe("(f) platesCorroborate — corroboration only, and deliberately narrow", () => {
  it("accepts the two REAL typo shapes", () => {
    // "T138003" vs "138003" — ours carries a leading T (July 2026 r45).
    expect(platesCorroborate(normTruck("T138003"), normTruck("138003"))).toBe("affix");
    // "ALA 3958" vs "ALA9958" — one character differs, 3 vs 9 (July 2026 r9).
    expect(platesCorroborate(normTruck("ALA 3958"), normTruck("ALA9958"))).toBe("substitution");
    // Space/hyphen/case are normalized away before any comparison happens.
    expect(platesCorroborate(normTruck("aav-6111"), normTruck("AAV 6111"))).toBe("exact");
  });

  it("REJECTS everything else — no edit-distance generalization", () => {
    // Two substitutions is a different truck, not a near miss.
    expect(platesCorroborate(normTruck("ALA 3958"), normTruck("ALB9958"))).toBeNull();
    // Different plates entirely.
    expect(platesCorroborate(normTruck("MAV 9202"), normTruck("KCA 378"))).toBeNull();
    // A transposition is NOT accepted (every extra rule accepts a truck that doesn't exist).
    expect(platesCorroborate(normTruck("ALA 3958"), normTruck("ALA 3985"))).toBeNull();
    // A short affix is too generic to corroborate anything.
    expect(platesCorroborate(normTruck("378"), normTruck("KCA 378"))).toBeNull();
    // A missing plate corroborates nothing.
    expect(platesCorroborate(null, normTruck("KCA 378"))).toBeNull();
    expect(platesCorroborate(normTruck("KCA 378"), null)).toBeNull();
  });
});

// ===========================================================================
// (d) SUPPLIER VARIANTS — canonical_supplier on BOTH sides.
// ===========================================================================
describe("(d) supplier canonicalization on both sides", () => {
  it("collapses the real variant pair that never used to key equal", () => {
    expect(canonicalSupplier("Paquibot/Compra")).toBe(canonicalSupplier("PAQUIBOT"));
    expect(canonicalSupplier("Paquibot/Compra")).toBe("PAQUIBOT");
  });

  it("does NOT over-collapse (see scripts/verify-supplier-canon.ts for the DB proof)", () => {
    // The ordered/non-overlapping ILIKE trap: the shared 'o' means SQL matches neither
    // order, so this stays itself. A naive contains-both mirror would merge it.
    expect(canonicalSupplier("MERCADORNALES")).toBe("MERCADORNALES");
    expect(canonicalSupplier("Ornales")).not.toBe(canonicalSupplier("Llanto"));
  });
});

// ===========================================================================
// THE END-TO-END PROOF — the real workbook, the real ten rows.
// ===========================================================================
describeWb("END-TO-END against the real workbook (the 10 rows that were unpriced)", () => {
  it("prices ALL TEN, at exactly the values Renzo confirmed", async () => {
    const rows = TEN.map((s, i) => mkRow(s, i + 1));
    const res = await enrichPrices(buf(), rows);

    expect(res.ok).toBe(true);
    // Fault (c): BOTH months the window spans were loaded, not just the newest.
    expect(res.months_requested).toEqual(["2026-07", "2026-08"]);
    expect(res.tabs_loaded).toEqual(["July 2026", "Aug. 2026"]);
    expect(res.matched_count).toBe(10);
    expect(res.unmatched_count).toBe(0);

    // Every single price, row by row — this is the number that reaches batches.avg_cost.
    for (let i = 0; i < TEN.length; i++) {
      expect(rows[i].cost_basis, `${TEN[i].date} ${TEN[i].plate} ${TEN[i].batch}`).toBe(TEN[i].want);
    }
  });

  it("the AUGUST rows alone are all priced — the exact set that read ₱0 for a week", async () => {
    const aug = TEN.filter((s) => s.date.startsWith("2026-08"));
    const rows = aug.map((s, i) => mkRow(s, i + 1));
    const res = await enrichPrices(buf(), rows);

    expect(res.tabs_loaded).toEqual(["Aug. 2026"]); // the tab that used to be unfindable
    expect(res.matched_count).toBe(aug.length);
    expect(rows.every((r) => (r.cost_basis ?? 0) > 0)).toBe(true);
  });

  it("(e)+(i) the three typo rows are priced AND every one is reported", async () => {
    const fuzzy = TEN.filter((s) => ["T138003", "ALA 3958"].includes(s.plate) || s.supplier === "Paquibot/Compra");
    expect(fuzzy).toHaveLength(3);

    const rows = fuzzy.map((s, i) => mkRow(s, i + 1));
    const res = await enrichPrices(buf(), rows);

    // ENRICH: all three carry Renzo's confirmed price.
    expect(res.matched_count).toBe(3);
    for (let i = 0; i < fuzzy.length; i++) {
      expect(rows[i].cost_basis, fuzzy[i].plate).toBe(fuzzy[i].want);
    }

    // …AND SURFACE: "bring it up in the sync but still proceed to enrich" (Renzo).
    const notes = res.notes.filter((n) => n.kind === "price_fuzzy_match");
    expect(notes.length).toBeGreaterThanOrEqual(3);

    // Each note must name the mismatched field with BOTH values side by side.
    const plateNote = notes.find((n) => n.truck_plate === "T138003");
    expect(plateNote).toBeDefined();
    const plateDiff = plateNote!.differences?.find((d) => d.field === "truck_plate");
    expect(plateDiff).toEqual({ field: "truck_plate", ours: "T138003", theirs: "138003" });
    expect(plateNote!.matched_sheet).toBe("July 2026");
    expect(plateNote!.matched_row).toBe(45);

    const subNote = notes.find((n) => n.truck_plate === "ALA 3958");
    expect(subNote).toBeDefined();
    expect(subNote!.differences?.find((d) => d.field === "truck_plate")).toEqual({
      field: "truck_plate", ours: "ALA 3958", theirs: "ALA9958",
    });
    expect(subNote!.matched_sheet).toBe("July 2026");
    expect(subNote!.matched_row).toBe(9);

    const supNote = notes.find((n) => n.supplier === "Paquibot/Compra");
    expect(supNote).toBeDefined();
    expect(supNote!.differences?.find((d) => d.field === "supplier")).toEqual({
      field: "supplier", ours: "Paquibot/Compra", theirs: "PAQUIBOT",
    });
    expect(supNote!.matched_sheet).toBe("July 2026");
    expect(supNote!.matched_row).toBe(34);

    // NO NOTE MAY CARRY A ₱ VALUE — the findings channel is not price-gated.
    for (const n of res.notes) {
      for (const k of Object.keys(n)) {
        expect(k, `note key ${k}`).not.toMatch(/cost|price_php|php_per|peso/i);
      }
    }
  });

  it("(g) a learned alias turns the plate typo into a clean EXACT match", async () => {
    // The seeded pair from migration 20260807040107. With it, the fallback rung is
    // never reached for this row — which is the point of remembering it.
    const aliases: SourceAlias[] = [{ kind: "truck_plate", ours: "T138003", theirs: "138003" }];
    const seed = TEN.find((s) => s.plate === "T138003")!;

    const withAlias = [mkRow(seed, 1)];
    const res = await enrichPrices(buf(), withAlias, { aliases });
    expect(withAlias[0].cost_basis).toBe(seed.want);
    expect(res.alias_match_count).toBe(1);
    expect(res.fallback_match_count).toBe(0);

    // Without it, the same row still prices — via the uniqueness-gated fallback.
    const noAlias = [mkRow(seed, 1)];
    const res2 = await enrichPrices(buf(), noAlias);
    expect(noAlias[0].cost_basis).toBe(seed.want);
    expect(res2.fallback_match_count).toBe(1);
    expect(res2.alias_match_count).toBe(0);
  });

  it("(g) an alias is EARNED only from a corroborated fallback, never guessed", async () => {
    const seed = TEN.find((s) => s.plate === "T138003")!;
    const res = await enrichPrices(buf(), [mkRow(seed, 1)]);
    const earned = res.learned.find((l) => l.kind === "truck_plate");
    expect(earned).toBeDefined();
    expect(earned!.ours).toBe("T138003");
    expect(earned!.theirs).toBe("138003");
    // `evidence` is NOT NULL in the DB precisely so a row can never exist without
    // saying how it was earned — so the worker must always supply a real one.
    expect(earned!.evidence.length).toBeGreaterThan(40);
    expect(earned!.evidence).toMatch(/EXACTLY ONE/);

    // An EXACT match teaches nothing new, so it must learn nothing.
    const plain = TEN.find((s) => s.plate === "KCA 378")!;
    const res2 = await enrichPrices(buf(), [mkRow(plain, 1)]);
    expect(res2.exact_match_count).toBe(1);
    expect(res2.learned).toEqual([]);
  });

  // =========================================================================
  // (b) THE LOUD FAILURE — the half that cost nine truckloads.
  // =========================================================================
  it("(b) an unresolvable tab names WHAT IT SOUGHT and WHAT IT FOUND", async () => {
    // December 2026 does not exist in her file. Nothing throws, nothing is silently
    // swallowed: the note carries both halves of the message.
    const row = mkRow({ ...TEN[0], date: "2026-12-05" }, 1);
    const res = await enrichPrices(buf(), [row]);

    expect(res.ok).toBe(false); // no month resolved → the file was unusable this run
    expect(row.cost_basis).toBe(0); // and nothing was invented

    const note = res.notes.find((n) => n.kind === "price_tab_unresolved");
    expect(note).toBeDefined();
    // WHAT IT SOUGHT:
    expect(note!.looked_for).toBe("December 2026");
    // WHAT IT FOUND — all 24, so a human can see the naming convention at a glance:
    expect(note!.tabs_found).toEqual([...REAL_TABS]);
    // And the message must NOT say the file was unavailable. It was right there.
    expect(note!.detail).toMatch(/NO tab for December 2026/);
    expect(note!.detail).toMatch(/file itself opened fine/);
    expect(note!.detail).not.toMatch(/unavailable/i);
  });

  it("(b) a PARTIAL failure still prices the months that did resolve", async () => {
    // The subtle case the old code could not express at all: August resolves,
    // December does not. `ok` stays true — the August rows were priced CORRECTLY —
    // but the December miss is still reported.
    //
    // The December row deliberately reuses a DIFFERENT truck/weight from the August
    // one, so this test isolates the tab-resolution behaviour. Reusing the same
    // supplier+plate+weight would instead exercise the date-drift bound (below),
    // because the exact key carries no date.
    const rows = [
      mkRow(TEN[0], 1),                                                     // 2026-08-05, resolvable
      mkRow({ ...TEN[0], date: "2026-12-05", plate: "QQQ 0000", kg: 12345 }, 2), // 2026-12-05, not
    ];
    const res = await enrichPrices(buf(), rows);

    expect(res.ok).toBe(true);
    expect(rows[0].cost_basis).toBe(TEN[0].want);
    expect(rows[1].cost_basis).toBe(0);
    expect(res.notes.some((n) => n.kind === "price_tab_unresolved" && n.looked_for === "December 2026")).toBe(true);
  });

  // =========================================================================
  // THE DATE-DRIFT BOUND — a fault this suite FOUND, not one the brief listed.
  //
  // The exact key is (supplier, plate, weight) with NO date, because the two files
  // do not share a date key (Czarina records the payment date). Correct — but
  // UNBOUNDED it prices a December delivery from an August row, since a regular
  // hauler running a full load reproduces the same triple every month. The Python
  // spec had `max_date_drift_days=7`; the TS port dropped it.
  //
  // Measured on this very workbook: 34 exact keys have >1 Czarina row, ALL 34 are
  // more than 7 days apart, NONE within 7 — and all ten confirmed rows matched at
  // drift 0. So the bound excludes only different truckloads.
  // =========================================================================
  it("a LONE out-of-range row reports the missing tab, and never reaches the index", async () => {
    // Worth pinning: when December is the ONLY month in the window, the run returns as
    // soon as no tab resolves — before any index exists. So the honest message is "no
    // tab for December", not a drift complaint about a row it never looked at.
    const row = mkRow({ ...TEN[0], date: "2026-12-05" }, 1);
    const res = await enrichPrices(buf(), [row]);

    expect(res.ok).toBe(false);
    expect(row.cost_basis).toBe(0);
    expect(res.czarina_rows_loaded).toBe(0);
    expect(res.notes.map((n) => n.kind)).toEqual(["price_tab_unresolved"]);
  });

  it("REFUSES a keyed match that is months away, and says so", async () => {
    // The drift bound bites when ANOTHER month of the window loaded her file, so the
    // index exists and the date-free exact key can reach across it. Here the August row
    // pulls in "Aug. 2026"; the December row then keys EXACTLY onto "Aug. 2026" row 13
    // (same supplier, plate and weight — a regular hauler's repeat full load) at a drift
    // of ~4 months. Unbounded, that is a ₱40.50 August rate stamped onto a December
    // delivery, silently, and then folded into batches.avg_cost.
    const rows = [
      mkRow(TEN[0], 1),                                // 2026-08-05 — loads "Aug. 2026"
      mkRow({ ...TEN[0], date: "2026-12-05" }, 2),     // same key, four months later
    ];
    const res = await enrichPrices(buf(), rows);

    // The August row is priced correctly…
    expect(rows[0].cost_basis).toBe(TEN[0].want);
    // …and the December row is NOT priced from a four-month-old row.
    expect(rows[1].cost_basis).toBe(0);

    const note = res.notes.find((n) => n.kind === "price_date_drift");
    expect(note).toBeDefined();
    expect(note!.transaction_date).toBe("2026-12-05");
    expect(note!.matched_sheet).toBe("Aug. 2026");
    expect(note!.date_tolerance_days!).toBeGreaterThan(7);
    expect(note!.detail).toMatch(/DOES have a row/);
    expect(note!.detail).toMatch(/DIFFERENT trip/);
    expect(note!.detail).toMatch(/Nothing was priced/);
    // It must not be misreported as a successful fuzzy match…
    expect(res.notes.some((n) => n.kind === "price_fuzzy_match")).toBe(false);
    // …and the missing December tab is STILL reported alongside it.
    expect(res.notes.some((n) => n.kind === "price_tab_unresolved" && n.looked_for === "December 2026")).toBe(true);
  });

  it("still prices within the payment-lag window (the bound costs no real match)", async () => {
    // All ten confirmed rows sit at drift 0, so the bound must not touch them…
    const rows = TEN.map((s, i) => mkRow(s, i + 1));
    const res = await enrichPrices(buf(), rows);
    expect(res.matched_count).toBe(10);
    expect(res.notes.some((n) => n.kind === "price_date_drift")).toBe(false);

    // …and a delivery recorded a few days before Czarina's payment date still prices,
    // which is the whole reason the key is date-free in the first place.
    const lag = mkRow({ ...TEN[0], date: "2026-08-02" }, 1); // her row is 2026-08-05 → 3d
    const res2 = await enrichPrices(buf(), [lag]);
    expect(lag.cost_basis).toBe(TEN[0].want);
    expect(res2.notes.some((n) => n.kind === "price_date_drift")).toBe(false);
  });

  it("(b) a corrupt file is reported as unreadable, NOT as unavailable", async () => {
    const res = await enrichPrices(Buffer.from("this is not a workbook"), [mkRow(TEN[0], 1)]);
    expect(res.ok).toBe(false);
    const note = res.notes.find((n) => n.kind === "price_file_unreadable");
    expect(note).toBeDefined();
    expect(note!.detail).toMatch(/could not be opened/);
    expect(note!.detail).not.toMatch(/unavailable/i);
  });

  // =========================================================================
  // (e) THE UNIQUENESS GATE — the safety property AND a duplicate detector.
  // =========================================================================
  it("(e) REFUSES a colliding triple on OUR side and names the twin", async () => {
    // Renzo measured this: across 1,327 deliveries since Jan 2025 the (date, weight,
    // sacks) triple is unique for 1,309, and all 9 colliding triples ARE known
    // duplicate pairs. So a collision is simultaneously "unsafe to price" and
    // "you probably have a duplicate row".
    //
    // Built from a REAL duplicate: the FEEDING # 1 row is a confirmed duplicate copy
    // of the Tag-at delivery — same weight, same sacks, same day, different batch.
    // Pricing either would put cost on a truck that does not exist.
    const twinA: Seed = { date: "2026-08-05", supplier: "Tag-at", batch: "AUGUST-26-BLK5", block: "A-12A", plate: "ZZZ 0001", sacks: 517, kg: 19185, want: 0 };
    const twinB: Seed = { date: "2026-08-05", supplier: "Tag-at", batch: "FEEDING # 1",    block: "F-1",   plate: "ZZZ 0002", sacks: 517, kg: 19185, want: 0 };

    const rows = [mkRow(twinA, 1), mkRow(twinB, 2)];
    const res = await enrichPrices(buf(), rows);

    // NOTHING was priced for either twin.
    expect(rows[0].cost_basis).toBe(0);
    expect(rows[1].cost_basis).toBe(0);

    const refusals = res.notes.filter((n) => n.kind === "price_fuzzy_ambiguous" && n.collided_on === "ours");
    expect(refusals.length).toBe(2); // both twins refused, neither picked
    expect(refusals[0].collisions).toHaveLength(2);
    expect(refusals[0].detail).toMatch(/OUR OWN report/);
    expect(refusals[0].detail).toMatch(/usually a duplicated row/);
    expect(refusals[0].detail).toMatch(/Nothing was priced/);
  });

  it("(e) a unique triple whose plate AND supplier both disagree is REFUSED", async () => {
    // (iii) of the ladder. A lone (date, weight, sacks) hit that agrees on nothing
    // else is a coincidence, not the same truckload — matching weight and sacks alone
    // is not evidence. Take a REAL Czarina row's date/weight/sacks but attach a
    // supplier and plate that corroborate nothing.
    const seed = TEN.find((s) => s.plate === "T138003")!;
    const impostor: Seed = { ...seed, supplier: "Zzz Nobody", plate: "QQQ 0000" };
    const rows = [mkRow(impostor, 1)];
    const res = await enrichPrices(buf(), rows);

    expect(rows[0].cost_basis).toBe(0);
    const note = res.notes.find((n) => n.kind === "price_fuzzy_ambiguous");
    expect(note).toBeDefined();
    expect(note!.detail).toMatch(/DIFFERENT supplier/);
    expect(note!.detail).toMatch(/coincidence, not the same truckload/);
    // Both sides are still shown, so a human can overrule the refusal knowingly.
    expect(note!.differences?.map((d) => d.field).sort()).toEqual(["supplier", "truck_plate"]);
  });

  it("(e) a row with no sack count cannot use the fallback at all", async () => {
    // The triple must EXIST to be unique. A missing sack count is not a key, so this
    // row is an ordinary unmatched row — NOT a refusal, and NOT a finding.
    const seed = TEN.find((s) => s.plate === "T138003")!;
    const row = mkRow({ ...seed, plate: "QQQ 0000" }, 1);
    row.sacks = null;
    const res = await enrichPrices(buf(), [row]);

    expect(row.cost_basis).toBe(0);
    expect(res.unmatched_count).toBe(1);
    expect(res.notes.filter((n) => n.kind === "price_fuzzy_ambiguous")).toEqual([]);
  });

  // =========================================================================
  // (h) SANITY-CHECK THE RESULT, not just the key.
  // =========================================================================
  it("(h) an in-band price raises nothing", async () => {
    // Ornales in August is ₱39.50–₱40.50 (Renzo). A match inside that says nothing.
    const bands = new Map<string, PriceBand>([["ORNALES", { min: 39.5, max: 40.5, n: 12 }]]);
    const seed = TEN.find((s) => s.plate === "KCA 378")!;
    const rows = [mkRow(seed, 1)];
    const res = await enrichPrices(buf(), rows, { priceBands: bands });

    expect(rows[0].cost_basis).toBe(seed.want);
    expect(res.notes.filter((n) => n.kind === "price_out_of_band")).toEqual([]);
  });

  it("(h) an OUT-of-band price is flagged even though the key was clean", async () => {
    // The only check that can catch a match that passed every key test and is still
    // wrong. Pretend Ornales normally charges ₱11–₱12 (the corrupted avg_cost figure):
    // a legitimate ₱40 match now looks nothing like the supplier's range.
    const bands = new Map<string, PriceBand>([["ORNALES", { min: 11.0, max: 12.0, n: 9 }]]);
    const seed = TEN.find((s) => s.plate === "KCA 378")!;
    const rows = [mkRow(seed, 1)];
    const res = await enrichPrices(buf(), rows, { priceBands: bands });

    // It still ENRICHES — an out-of-band match is a question, not a veto.
    expect(rows[0].cost_basis).toBe(seed.want);
    const note = res.notes.find((n) => n.kind === "price_out_of_band");
    expect(note).toBeDefined();
    expect(note!.truck_plate).toBe("KCA 378");
    expect(note!.detail).toMatch(/OUTSIDE/);
    expect(note!.detail).toMatch(/price WAS applied/);
    // …and it must not print the ₱ figure into an ungated channel.
    expect(note!.detail).not.toMatch(/40\.0|39\.5|11\.0/);
  });

  it("(h) a band too thin to be evidence is ignored", async () => {
    const bands = new Map<string, PriceBand>([["ORNALES", { min: 11.0, max: 12.0, n: 1 }]]);
    const seed = TEN.find((s) => s.plate === "KCA 378")!;
    const res = await enrichPrices(buf(), [mkRow(seed, 1)], { priceBands: bands });
    expect(res.notes.filter((n) => n.kind === "price_out_of_band")).toEqual([]);
  });

  it("is IDEMPOTENT — enriching twice yields the same prices and the same notes", async () => {
    const a = TEN.map((s, i) => mkRow(s, i + 1));
    const b = TEN.map((s, i) => mkRow(s, i + 1));
    const ra = await enrichPrices(buf(), a);
    const rb = await enrichPrices(buf(), b);
    expect(a.map((r) => r.cost_basis)).toEqual(b.map((r) => r.cost_basis));
    expect(ra.notes.map((n) => n.kind).sort()).toEqual(rb.notes.map((n) => n.kind).sort());
    expect(ra.matched_count).toBe(rb.matched_count);
  });

  it("an empty row list is a no-op, not an error", async () => {
    const res = await enrichPrices(buf(), []);
    expect(res.matched_count).toBe(0);
    expect(res.unmatched_count).toBe(0);
    expect(res.notes).toEqual([]);
    expect(res.months_requested).toEqual([]);
  });
});

// ===========================================================================
// Normalizer parity with the Python spec (enrich_prices.py).
// ===========================================================================
describe("normalizers — Python parity", () => {
  it("normTruck strips whitespace/hyphen/underscore and uppercases", () => {
    expect(normTruck("aav-6111")).toBe("AAV6111");
    expect(normTruck(" MAV 9202 ")).toBe("MAV9202");
    expect(normTruck("t_138_003")).toBe("T138003");
    expect(normTruck("")).toBeNull();
    expect(normTruck("   ")).toBeNull();
    expect(normTruck(null)).toBeNull();
  });

  it("normWeight rounds to whole kg", () => {
    expect(normWeight(23515.0)).toBe(23515);
    expect(normWeight("19010.00")).toBe(19010);
    expect(normWeight(9754.6)).toBe(9755);
    expect(normWeight("not a number")).toBeNull();
    expect(normWeight(null)).toBeNull();
  });
});
