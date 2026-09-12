/**
 * deliveries-reprice.test.ts — the regression suite for the 2026-09-12 pricing stall
 * (L-050), built from the REAL `Sept. 2026` tab of Czarina's workbook and the REAL
 * eleven unpriced rows that were sitting in `public.deliveries` when it was found.
 *
 * ============================================================================
 * WHAT BROKE
 * ============================================================================
 * Eleven deliveries dated 2026-09-08 … 09-11 sat at `cost_basis = 0` (run `8500acc9`).
 * Czarina's `RAW CHARCOAL PURCHASES -Daily(1).xlsx` WAS in the mailbox and WAS downloaded
 * into `sync-inbox/<run>/deliveries_czarina/`; its `Sept. 2026` tab carries the matching
 * priced rows. `apply.price_notes` was `[]` on both the deliveries and the gsheet section.
 *
 * Nothing was wrong with the file, the tab resolver, the matcher, the aliases or the
 * bands. THE PRICE STEP WAS NOT REACHABLE: `enrichPrices` ran in exactly one place —
 * inside the RC DELIVERIES email report, over THAT EMAIL'S rows — and no RC DELIVERIES
 * email had arrived since 09-09. Every one of those eleven rows had been INSERTED by the
 * Google Sheet path, which writes the ₱0 placeholder and leaves a comment saying
 * "deliveries-manager to enrich from Czarina/email". Nobody enriched them.
 *
 * ============================================================================
 * THE FIXTURE
 * ============================================================================
 * `SEPT_2026_ROWS` is rows 5–28 of the real `Sept. 2026` worksheet, read out of the
 * workbook that run downloaded, VERBATIM — including the `-` date carry-forward marker
 * that appears on 15 of the 24 rows, the LABAO row with no plate and no gross weight, and
 * `LEA932` where our own record says `LEA  9232`. The workbook is rebuilt in-memory rather
 * than checked in (the same choice `deliveries-price-enrichment.test.ts` makes for her
 * real file), so the suite runs in CI with no `.sync-flags/` and no network.
 *
 * `UNPRICED` is the eleven `deliveries` rows exactly as they read on 2026-09-12.
 *
 * MEASURED, against the real workbook, before this suite was frozen: 10 of the 11 price —
 * 9 on the exact key, 1 on the uniqueness-gated fallback (the `LEA932` spelling). The one
 * that does not is the RE-COOKED processing fee, and it SHOULD not: Czarina's only row
 * with that date/weight/sacks names LABAO, and neither side carries a plate, so the
 * fallback's independent-corroboration rule refuses it. That row is the `recook_refeed`
 * case — a fee, not a purchase — which `unpriced_overdue` now reports at `info`.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import {
  repriceUnpricedDeliveries,
  REPRICE_LOOKBACK_DAYS,
  type RepriceCandidate,
} from "../../src/reports/deliveries/reprice.js";
import type { PriceNote } from "../../src/reports/deliveries/enrich.js";
import type { DbClient } from "../../src/lib/db.js";

// ---------------------------------------------------------------------------
// The real `Sept. 2026` tab — rows 5..28, verbatim.
//   [date | "-" | "", supplier, plate, block, sacks, gross, less, net, php, amount]
// ---------------------------------------------------------------------------
type CzRow = [string, string, string, string, number | "", number | "", number | "", number, number, number];

const SEPT_2026_ROWS: CzRow[] = [
  ["2026-09-01", "PAQUIBOT", "MAN3625", "#12", 485, 33140, "", 21350, 40.5, 864675],
  ["-", "ORNALES", "MAV9202", "#1", 590, 34120, "", 20690, 40.5, 837945],
  ["-", "ORNALES", "CBN2192", "#1", 288, 16185, "", 10650, 40.5, 431325],
  ["2026-09-02", "TAG-AT", "KCA378", "No.1", 502, 31395, "", 19385, 39, 756015],
  ["2026-09-03", "ORNALES", "MCV7006", "#2", 541, 40255, 2265, 26050, 40.5, 1055025],
  ["2026-09-04", "ORNALES", "CDD1689", "#1`", 459, 28200, "", 16850, 40.5, 682425],
  ["-", "ORNALES", "CAC6420", "#1", 292, 16720, "", 11020, 40.5, 446310],
  ["2026-09-05", "ORNALES", "AAV6111", "#3", 461, 29060, "", 17240, 40, 689600],
  ["-", "ORNALES", "LFF835", "#3", 304, 15030, "", 9560, 40.5, 387180],
  ["-", "ORNALES", "CAC6420", "#14", 317, 16735, "", 11240, 40.5, 455220],
  ["2026-09-07", "TAG-AT", "KCA378", "No.2", 482, 31205, "", 19170, 39, 747630],
  ["-", "ORNALES", "CAC6420", "#3", 236, 14790, "", 9215, 40.5, 373207.5],
  ["2026-09-08", "PAQUIBOT", "KBK1261", "#12", 59, 4225, "", 2150, 40.5, 87075],
  // The re-cook: no plate, no gross weight, a ₱1.75 PROCESSING FEE rather than a rate.
  ["-", "LABAO", "", "", 14, "", "", 7134, 1.75, 12484.5],
  ["2026-09-09", "ORNALES", "AAV6111", "#3", 520, 29770, "", 17985, 40, 719400],
  ["-", "ORNALES", "CBN2192", "#3", 268, 16355, "", 10880, 40.5, 440640],
  ["2026-09-10", "PAQUIBOT", "MAN3625", "#5", 485, 32030, "", 20235, 40.5, 819517.5],
  ["-", "TAG-AT", "KCA378", "No.3", 509, 31535, "", 19510, 39, 760890],
  // Her spelling of the plate our record writes as "LEA  9232".
  ["-", "ORNALES", "LEA932", "#4", 360, 17065, "", 11645, 40.5, 471622.5],
  ["2026-09-11", "ORNALES", "CBN2192", "#4", 297, 16235, "", 10705, 40.5, 433552.5],
  ["-", "LLANTO", "ALA9958", "#9", 550, 34285, "", 22840, 37.25, 850790],
  ["-", "ORNALES", "MAV9202", "#4", 628, 32450, "", 18900, 40.5, 765450],
  ["-", "ESITO", "KDE457", "#9", 226, 13440, "", 7555, 39, 294645],
  ["-", "ORNALES", "CBN2192", "#4", 315, 17125, "", 11650, 40.5, 471825],
];

/** Data rows start at R5; R1–R4 are the title + the two header rows. */
async function buildCzarinaWorkbook(tabName = "Sept. 2026"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(tabName);
  ws.getRow(1).getCell(1).value = "Month";
  ws.getRow(1).getCell(2).value = "SEPTEMBER 2026";
  ws.getRow(3).values = ["Date of ", "Supplier's", "Truck ", "Piling", "Delivery", "Gross", "MC/ Ash", "NET", "", "Total"];
  ws.getRow(4).values = ["Del.paid", " Name", "PLATE #", "Block", "(#sacks)", "weight", "KLS FOR SK (20%)", "(#kilos)", "PHP/kg.", "Amount"];
  SEPT_2026_ROWS.forEach((r, i) => {
    const row = ws.getRow(5 + i);
    const [d, supplier, plate, block, sacks, gross, less, net, php, amount] = r;
    // A real date cell where she typed one; the literal "-" carry-forward marker elsewhere.
    if (d === "-" || d === "") row.getCell(1).value = d;
    else {
      const [y, m, day] = d.split("-").map(Number);
      row.getCell(1).value = new Date(Date.UTC(y, m - 1, day));
    }
    row.getCell(2).value = supplier;
    row.getCell(3).value = plate;
    row.getCell(4).value = block;
    row.getCell(5).value = sacks === "" ? null : sacks;
    row.getCell(6).value = gross === "" ? null : gross;
    row.getCell(7).value = less === "" ? null : less;
    row.getCell(8).value = net;
    row.getCell(9).value = php;
    row.getCell(10).value = amount;
  });
  // The subtotal row her sheet carries; `readCzarinaSheet` must skip it (blank supplier).
  ws.getRow(5 + SEPT_2026_ROWS.length + 27).values = ["", "", "", "", 9188, "", 2265, 353609, "", 13854449.5];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// The eleven rows, exactly as `public.deliveries` held them on 2026-09-12.
// `want` is what the ladder should find; null = must stay unpriced.
// ---------------------------------------------------------------------------
interface Seed extends RepriceCandidate {
  want: number | null;
  human_edited_at?: string | null;
  cost_basis?: number;
}

const UNPRICED: Seed[] = [
  { id: "d01", transaction_date: "2026-09-08", supplier: "RE-COOKED", batch_code: "SEPT-26-RECOOKED1", block_loc: null, truck_plate: null, sacks: 14, weight_kg: 7134, want: null },
  { id: "d02", transaction_date: "2026-09-09", supplier: "Ornales", batch_code: "SEPT-26-BLK3", block_loc: null, truck_plate: "CBN 2192", sacks: 268, weight_kg: 10880, want: 40.5 },
  { id: "d03", transaction_date: "2026-09-09", supplier: "Ornales", batch_code: "SEPT-26-BLK3", block_loc: null, truck_plate: "AAV 6111", sacks: 520, weight_kg: 17985, want: 40 },
  { id: "d04", transaction_date: "2026-09-10", supplier: "Tag-at", batch_code: "SEPT-26-FEED3", block_loc: null, truck_plate: "KCA 378", sacks: 509, weight_kg: 19510, want: 39 },
  { id: "d05", transaction_date: "2026-09-10", supplier: "Paquibot", batch_code: "SEPT-26-BLK5", block_loc: null, truck_plate: "MAN 3625", sacks: 485, weight_kg: 20235, want: 40.5 },
  { id: "d06", transaction_date: "2026-09-10", supplier: "Ornales", batch_code: "SEPT-26-BLK4", block_loc: null, truck_plate: "CBN 2192", sacks: 297, weight_kg: 10705, want: 40.5 },
  { id: "d07", transaction_date: "2026-09-10", supplier: "Ornales", batch_code: "SEPT-26-BLK4", block_loc: null, truck_plate: "LEA  9232", sacks: 360, weight_kg: 11645, want: 40.5 },
  { id: "d08", transaction_date: "2026-09-11", supplier: "Ornales", batch_code: "SEPT-26-BLK4", block_loc: null, truck_plate: "CBN 2192", sacks: 315, weight_kg: 11650, want: 40.5 },
  { id: "d09", transaction_date: "2026-09-11", supplier: "Llanto", batch_code: "AUGUST-26-BLK9", block_loc: null, truck_plate: "ALA 9958", sacks: 550, weight_kg: 22840, want: 37.25 },
  { id: "d10", transaction_date: "2026-09-11", supplier: "Ornales", batch_code: "SEPT-26-BLK4", block_loc: null, truck_plate: "MAV 9202", sacks: 628, weight_kg: 18900, want: 40.5 },
  { id: "d11", transaction_date: "2026-09-11", supplier: "Esito", batch_code: "AUGUST-26-BLK9", block_loc: null, truck_plate: "KDE 457", sacks: 226, weight_kg: 7555, want: 39 },
];

/** The run instant. Inside the 45-day lookback of every seeded date. */
const RUN_TS = "2026-09-12T01:00:00.000Z";

// ---------------------------------------------------------------------------
// A stub DbClient that HONOURS the query filters, so the tests prove the READ is
// right — not merely that the stub handed back what the test wanted.
// ---------------------------------------------------------------------------
interface StubOpts {
  /** Override the outcome the latch RPC returns for a given id. */
  outcomes?: Record<string, string>;
  /** Make applyDeliveryUpstream throw. */
  rpcThrows?: boolean;
}

function makeDb(seeds: Seed[], opts: StubOpts = {}) {
  const table = seeds.map((s) => ({
    ...s,
    cost_basis: s.cost_basis ?? 0,
    human_edited_at: s.human_edited_at ?? null,
  }));
  const reads: Array<{ table: string; opts: Record<string, unknown> }> = [];
  const ops: Array<Record<string, unknown>> = [];
  const audits: Array<{ recordId: string; comment: string }> = [];

  const db = {
    async readRows(tableName: string, o: Record<string, unknown> = {}) {
      reads.push({ table: tableName, opts: o });
      const f = (o.extraFilters ?? {}) as Record<string, string>;
      const since = (o.sinceDate ?? null) as string | null;
      return table.filter((r) => {
        if (since && r.transaction_date < since) return false;
        if (f.cost_basis === "eq.0" && r.cost_basis !== 0) return false;
        if (f.human_edited_at === "is.null" && r.human_edited_at !== null) return false;
        return true;
      }) as unknown as Array<Record<string, unknown>>;
    },
    async applyDeliveryUpstream(o: Array<Record<string, unknown>>) {
      if (opts.rpcThrows) throw new Error("boom");
      ops.push(...o);
      return o.map((op) => {
        const id = String(op.id);
        const outcome = opts.outcomes?.[id] ?? "applied";
        if (outcome === "applied") {
          const row = table.find((r) => r.id === id);
          const patch = op.patch as Record<string, unknown>;
          if (row) row.cost_basis = Number(patch.cost_basis);
        }
        return { id, outcome };
      });
    },
    async stampIngestionAudit(a: { recordId: string; comment: string }) {
      audits.push(a);
      return true;
    },
    async writeIngestionAudit() {
      return { id: "audit" };
    },
    async recordSourceAlias() {
      return "alias";
    },
  };
  return { db: db as unknown as DbClient, table, reads, ops, audits };
}

const kinds = (notes: readonly PriceNote[]): string[] => notes.map((n) => n.kind);

// ---------------------------------------------------------------------------
describe("the re-price pass (L-050)", () => {
  it("prices the deliveries the 2026-09-12 run left at ₱0 — 10 of 11, 9 exact + 1 fallback", async () => {
    const buf = await buildCzarinaWorkbook();
    const { db, table, ops } = makeDb(UNPRICED);

    const res = await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });

    expect(res.ran).toBe(true);
    expect(res.considered).toBe(11);
    expect(res.priced).toBe(10);
    expect(res.tabs_read).toEqual(["Sept. 2026"]);
    expect(res.months_requested).toEqual(["2026-09"]);

    // Every op is a cost_basis-only patch through the latch-aware RPC.
    expect(ops).toHaveLength(10);
    for (const op of ops) {
      expect(Object.keys(op.patch as Record<string, unknown>)).toEqual(["cost_basis"]);
    }

    // The four rows quoted in the incident report, each at the rate on her sheet.
    const by = (id: string) => table.find((r) => r.id === id)!;
    expect(by("d03").cost_basis).toBe(40); // 2026-09-09 ORNALES AAV6111 520 sk 17,985 kg
    expect(by("d05").cost_basis).toBe(40.5); // 2026-09-10 PAQUIBOT MAN3625 485 sk 20,235 kg
    expect(by("d06").cost_basis).toBe(40.5); // ours 09-10 vs hers 09-11 — the exact key carries no date
    expect(by("d09").cost_basis).toBe(37.25); // 2026-09-11 LLANTO ALA9958 550 sk 22,840 kg

    // …and every other expectation, including the one that must NOT be priced.
    for (const s of UNPRICED) {
      expect(by(s.id).cost_basis).toBe(s.want ?? 0);
    }
  });

  it("reads only rows at the ₱0 placeholder that no human owns — the query proves it", async () => {
    const buf = await buildCzarinaWorkbook();
    const seeds: Seed[] = [
      // Already priced: not a candidate, and therefore never re-priced.
      { ...UNPRICED[1], id: "priced", cost_basis: 99, want: null },
      // A human owns it: excluded by the read as well as by the RPC.
      { ...UNPRICED[2], id: "latched", human_edited_at: "2026-09-11T00:00:00Z", want: null },
      UNPRICED[3],
    ];
    const { db, table, ops, reads } = makeDb(seeds);

    const res = await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });

    const read = reads.find((r) => r.table === "deliveries")!;
    expect(read.opts.extraFilters).toMatchObject({
      cost_basis: "eq.0",
      human_edited_at: "is.null",
    });
    expect(res.considered).toBe(1);
    expect(res.priced).toBe(1);
    expect(ops.map((o) => o.id)).toEqual([UNPRICED[3].id]);
    expect(table.find((r) => r.id === "priced")!.cost_basis).toBe(99);
    expect(table.find((r) => r.id === "latched")!.cost_basis).toBe(0);
  });

  it("a row claimed between the read and the write is REFUSED by the DB and reported without the ₱", async () => {
    const buf = await buildCzarinaWorkbook();
    const { db, table } = makeDb(UNPRICED, { outcomes: { d05: "human_edited" } });

    const res = await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });

    expect(res.priced).toBe(9);
    expect(table.find((r) => r.id === "d05")!.cost_basis).toBe(0);
    expect(res.human_edits).toHaveLength(1);
    const he = res.human_edits[0];
    expect(he.record_id).toBe("d05");
    expect(he.outcome).toBe("refused_by_db");
    // The findings channel is not price-gated: the field is named, the value never travels.
    expect(he.changed_fields).toEqual([
      { field: "cost_basis", yours: null, sheet: null, redacted: true },
    ]);
    expect(JSON.stringify(he)).not.toContain("40.5");
    // A refusal is arbitration, not an error — it must not look like a broken run.
    expect(res.errors).toEqual([]);
  });

  it("is a NO-OP on a second pass over the same workbook — no ops, no notes, no audit", async () => {
    const buf = await buildCzarinaWorkbook();
    const czarina = { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" };
    const { db, ops, audits } = makeDb(UNPRICED);
    const deps = {
      db,
      czarina,
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    };

    const first = await repriceUnpricedDeliveries(deps);
    expect(first.priced).toBe(10);
    expect(audits).toHaveLength(10);

    const before = ops.length;
    const second = await repriceUnpricedDeliveries(deps);
    // Only the row that could never be priced is still a candidate; nothing is written.
    expect(second.considered).toBe(1);
    expect(second.priced).toBe(0);
    expect(second.notes).toEqual([]);
    expect(ops.length).toBe(before);
    expect(audits).toHaveLength(10);
  });

  it("NEVER raises price_no_row_matched — 0-of-N is ordinary for this population", async () => {
    const buf = await buildCzarinaWorkbook();
    // Only the re-cook, which by design cannot match: a 100% miss.
    const { db } = makeDb([UNPRICED[0]]);

    const res = await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });

    expect(res.priced).toBe(0);
    // No wrong-workbook alarm, and no per-row refusal either — `unpriced_overdue`
    // already names this row, by id, in the same run.
    expect(kinds(res.notes)).toEqual([]);
  });

  it("reports a priced row as `price_repriced` (info) and never carries the rate", async () => {
    const buf = await buildCzarinaWorkbook();
    const { db } = makeDb([UNPRICED[4]]); // PAQUIBOT MAN3625, an exact-key match at ₱40.50

    const res = await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });

    expect(kinds(res.notes)).toEqual(["price_repriced"]);
    const n = res.notes[0];
    expect(n.transaction_date).toBe("2026-09-10");
    expect(n.truck_plate).toBe("MAN 3625");
    expect(n.sacks).toBe(485);
    expect(n.matched_sheet).toBe("Sept. 2026");
    expect(n.via).toBe("exact");
    expect(JSON.stringify(n)).not.toContain("40.5");
  });

  it("a fuzzy match still ENRICHES and is still reported with both spellings", async () => {
    const buf = await buildCzarinaWorkbook();
    const { db, table } = makeDb([UNPRICED[6]]); // ours "LEA  9232" vs hers "LEA932"

    const res = await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });

    expect(table[0].cost_basis).toBe(40.5);
    expect(kinds(res.notes).sort()).toEqual(["price_fuzzy_match", "price_repriced"]);
    const fuzzy = res.notes.find((n) => n.kind === "price_fuzzy_match")!;
    expect(fuzzy.differences?.[0]).toMatchObject({
      field: "truck_plate",
      ours: "LEA  9232",
      theirs: "LEA932",
    });
    // …and the spelling pair is EARNED, so the next run matches it on the exact key.
    expect(res.learned).toHaveLength(1);
    expect(res.learned[0]).toMatchObject({ kind: "truck_plate", ours: "LEA9232", theirs: "LEA932" });
  });

  it("does nothing at all when no price workbook reached the run", async () => {
    const { db, ops } = makeDb(UNPRICED);
    const res = await repriceUnpricedDeliveries({
      db,
      czarina: null,
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });
    expect(res.ran).toBe(false);
    expect(res.considered).toBe(0);
    expect(res.notes).toEqual([]);
    expect(ops).toEqual([]);
  });

  it("a whole-month tab miss is still LOUD — unless this run already said it", async () => {
    const buf = await buildCzarinaWorkbook("Aug. 2026"); // no September tab at all
    const { db } = makeDb(UNPRICED);
    const base = {
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    };

    const loud = await repriceUnpricedDeliveries(base);
    expect(kinds(loud.notes)).toEqual(["price_tab_unresolved"]);
    expect(loud.notes[0].looked_for).toBe("September 2026");

    // The email path already raised the identical complaint → not said twice.
    const quiet = await repriceUnpricedDeliveries({
      ...base,
      alreadyNoted: [
        { kind: "price_tab_unresolved", looked_for: "September 2026", detail: "already said" },
      ],
    });
    expect(quiet.notes).toEqual([]);
  });

  it("a failed write is an `errors[]` entry, never a lost price and never a thrown run", async () => {
    const buf = await buildCzarinaWorkbook();
    const { db, table } = makeDb(UNPRICED, { rpcThrows: true });

    const res = await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-01",
      runTs: RUN_TS,
    });

    expect(res.priced).toBe(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/still\s+unpriced/);
    expect(table.every((r) => r.cost_basis === 0)).toBe(true);
  });

  it("looks back 45 days — the window the email path's `watermark − 3d` cannot reach", async () => {
    const buf = await buildCzarinaWorkbook();
    const { db, reads } = makeDb(UNPRICED);
    // `since` from the report is 2026-09-08 (a watermark of 09-11 minus 3 days), which on
    // its own would leave the 09-08 row inside and everything older permanently outside.
    await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-09-08",
      runTs: RUN_TS,
    });
    // 2026-09-12 (Asia/Manila) − 45 days.
    expect(reads[0].opts.sinceDate).toBe("2026-07-29");
    expect(REPRICE_LOOKBACK_DAYS).toBe(45);
  });

  it("takes the EARLIER of the report window and the 45-day floor, never the later", async () => {
    const buf = await buildCzarinaWorkbook();
    const { db, reads } = makeDb(UNPRICED);
    await repriceUnpricedDeliveries({
      db,
      czarina: { buf, filename: "RAW CHARCOAL PURCHASES -Daily(1).xlsx" },
      aliases: [],
      priceBands: new Map(),
      since: "2026-01-01", // a cold start, far wider than the floor
      runTs: RUN_TS,
    });
    expect(reads[0].opts.sinceDate).toBe("2026-01-01");
  });
});
