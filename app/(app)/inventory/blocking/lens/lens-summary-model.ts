// ─────────────────────────────────────────────────────────────────────────────
// THE PRINTED LENS SUMMARY'S BLOCK LISTS — bucketed by BAND, then by WAREHOUSE.
//
// The owner, on the live lens print: *"I don't like the three-column groupings —
// subgroup what fits each band by WAREHOUSE location; spanning multiple pages is fine
// because you can fit more lab analysis data."* So a band's blocks are no longer a
// compact three-column list of codes: they are a full-width TABLE grouped by the
// warehouse the block sits in, with every lab reading the grid already holds.
//
// This module is the ONE bucketing, shared by all three lenses. Three copies of it is
// how the price sheet and the age sheet would end up ordering warehouses differently,
// or one of them quietly folding an un-lensed block into a band.
//
// ── ⚠️ THE ONE SUM IN THE WHOLE LENS DIRECTORY, AND WHY IT IS ALLOWED ───────
// Every other figure a lens shows is SQL's, rendered verbatim, and
// `scripts/verify-blocking-lens-ui.ts` asserts that no lens file sums a kilogram. This
// file is the single stated exception, and the reason is the same distinction
// `blend-analysis-print.ts` already draws about its per-row `kg × ₱/kg` product:
//
//   **the payload publishes NO figure for "band 2's kilograms in warehouse C"**, at any
//   grain, so this sum has nothing it could disagree with. Every number BESIDE it — the
//   band's own kg and share, the yard total, each lens's weighted figure — is still the
//   payload's, and the verify script proves the warehouse subtotals of a band FOLD BACK
//   to the band's own published kilograms rather than replacing them.
//
// What is still absolutely forbidden, and is NOT done here: a weighted average. A
// warehouse subtotal's lab cells are left **BLANK**, because a kg-weighted MC over a
// partition SQL never computed would be a second definition of a lab average living in
// TypeScript — which is the project rule this exception must not be read as widening.
// A blank cell says "not published"; a computed one would say something untrue.
//
// PURE: no React, no fetch, no server action.
// ─────────────────────────────────────────────────────────────────────────────

import { WAREHOUSES } from '../constants';
import type { BlockData } from '../types';

/** The seven lab readings, in the Excel-Standard RC IN column order. */
export const LENS_SUMMARY_LAB_KEYS = [
  'mc',
  'ash',
  'bdAstm',
  'bdJis',
  'grit',
  'vm',
  'fc',
] as const;

export type LensSummaryLabKey = (typeof LENS_SUMMARY_LAB_KEYS)[number];

/** One block's readings, PREFORMATTED — MC/GRIT/VM/ASH/FC 2 dp, both BDs 3 dp. */
export type LensSummaryLab = Record<LensSummaryLabKey, string>;

/** The column headings, so the sheet does not spell them and neither does a lens. */
export const LENS_SUMMARY_LAB_LABELS: Record<LensSummaryLabKey, string> = {
  mc: 'MC',
  ash: 'ASH',
  bdAstm: 'BD ASTM',
  bdJis: 'BD JIS',
  grit: 'GRIT',
  vm: 'VM',
  fc: 'FC',
};

export interface LensSummaryBlockRow {
  blockLoc: string;
  batchCode: string;
  /** `74,590 kg`, preformatted. */
  kg: string;
  /** `₱48.50` · `412.7 d` · `Llanto 71%`, preformatted. Never a bare number. */
  figure: string;
  lab: LensSummaryLab;
}

export interface LensSummaryWarehouse {
  /** `A` … `D`, `PCA`, `PCB`, or `-` for a block whose prefix is not a warehouse. */
  key: string;
  /** `WHSE A` / `PCA` — what the group heading reads. */
  label: string;
  /** `12 blocks`, preformatted. */
  blocks: string;
  /** `757,293 kg`, preformatted — the ONE sum this module makes. See the header. */
  kg: string;
  rows: LensSummaryBlockRow[];
}

/**
 * `-` sorts last and is a real answer: a `block_loc` whose prefix is not one of the six
 * warehouses is still a block, and dropping it would make the sheet disagree with the
 * band table above it about how many blocks the band holds.
 */
const UNKNOWN_WAREHOUSE = '-';

/** The page's own warehouse order, read from the grid's layout — never re-listed here. */
const WAREHOUSE_ORDER: readonly string[] = [...Object.keys(WAREHOUSES), UNKNOWN_WAREHOUSE];

function warehouseLabel(key: string): string {
  if (key === UNKNOWN_WAREHOUSE) return 'Other';
  // PCA / PCB are places, not letters — "WHSE PCA" is not what anyone calls them.
  return key.length === 1 ? `WHSE ${key}` : key;
}

/** `A-10B` → `A`; `PCA-15A` → `PCA`. The grid builds a loc as `<whse>-<col><row>`. */
export function warehouseOfBlockLoc(blockLoc: string): string {
  const prefix = blockLoc.split('-')[0]?.trim().toUpperCase() ?? '';
  return prefix in WAREHOUSES ? prefix : UNKNOWN_WAREHOUSE;
}

function lab2(v: number): string {
  return v.toFixed(2);
}

function lab3(v: number): string {
  return v.toFixed(3);
}

/** The Excel Standard, applied once: BD → 3 decimals, everything else → 2. */
export function lensSummaryLab(block: BlockData): LensSummaryLab {
  return {
    mc: lab2(block.mc),
    ash: lab2(block.ash),
    bdAstm: lab3(block.bd_astm),
    bdJis: lab3(block.bd_jis),
    grit: lab2(block.grit),
    vm: lab2(block.vm),
    fc: lab2(block.fc),
  };
}

export interface LensSummaryBucketInput {
  /** The live grid map the lens was handed. */
  data: Record<string, BlockData>;
  /** `block_loc` → band index, or `undefined` for a block the lens cannot PLACE. */
  bandOf: (blockLoc: string) => number | undefined;
  /** This lens's own figure for one block, preformatted (`₱48.50`, `412.7 d`). */
  figureOf: (blockLoc: string, block: BlockData) => string;
  /** What to order rows by INSIDE a warehouse, descending. */
  sortKeyOf: (blockLoc: string, block: BlockData) => number;
  /** `1,275,018 kg` — the lens's shared kilogram formatter. */
  formatKg: (n: number) => string;
  /** `12 blocks` — the lens's shared block-count formatter. */
  formatBlocks: (n: number) => string;
  /** What an unplaced block's figure cell reads. An em dash, never a zero. */
  excludedFigure: string;
}

export interface LensSummaryBuckets {
  /** band index → its warehouse groups, in the page's warehouse order. */
  byBand: Map<number, LensSummaryWarehouse[]>;
  /** The blocks in NO band, in block order. Never folded into a band. */
  excludedRows: LensSummaryBlockRow[];
}

/**
 * Bucket every occupied block of the grid map into `band → warehouse → rows`.
 *
 * A block the lens cannot place (unpriced, undated, no supplier at all) goes to
 * `excludedRows` and **never into a band** — the ₱11.01-vs-₱39.99 `avg_cost` mistake in
 * its fourth costume. Rows inside a warehouse are ordered by the caller's own key,
 * descending, so the dearest / oldest / biggest is first exactly as it is on screen.
 */
export function buildLensSummaryBuckets(input: LensSummaryBucketInput): LensSummaryBuckets {
  const { data, bandOf, figureOf, sortKeyOf, formatKg, formatBlocks } = input;

  interface Draft {
    row: LensSummaryBlockRow;
    sortBy: number;
    balance: number;
  }

  const drafts = new Map<number, Map<string, Draft[]>>();
  const excludedRows: LensSummaryBlockRow[] = [];

  for (const [loc, block] of Object.entries(data)) {
    const lab = lensSummaryLab(block);
    const band = bandOf(loc);
    if (band === undefined) {
      excludedRows.push({
        blockLoc: loc,
        batchCode: block.batch_code,
        kg: formatKg(block.balance),
        figure: input.excludedFigure,
        lab,
      });
      continue;
    }
    const whse = warehouseOfBlockLoc(loc);
    const perBand = drafts.get(band) ?? new Map<string, Draft[]>();
    const list = perBand.get(whse) ?? [];
    list.push({
      row: {
        blockLoc: loc,
        batchCode: block.batch_code,
        kg: formatKg(block.balance),
        figure: figureOf(loc, block),
        lab,
      },
      sortBy: sortKeyOf(loc, block),
      balance: block.balance,
    });
    perBand.set(whse, list);
    drafts.set(band, perBand);
  }

  excludedRows.sort((a, b) => a.blockLoc.localeCompare(b.blockLoc));

  const byBand = new Map<number, LensSummaryWarehouse[]>();
  for (const [band, perBand] of drafts) {
    const groups: LensSummaryWarehouse[] = [];
    for (const key of WAREHOUSE_ORDER) {
      const list = perBand.get(key);
      if (!list || list.length === 0) continue;
      list.sort((a, b) => b.sortBy - a.sortBy);
      // THE ONE SUM — a partition the payload does not publish. See the header note.
      let kg = 0;
      for (const d of list) kg = kg + d.balance;
      groups.push({
        key,
        label: warehouseLabel(key),
        blocks: formatBlocks(list.length),
        kg: formatKg(kg),
        rows: list.map((d) => d.row),
      });
    }
    byBand.set(band, groups);
  }

  return { byBand, excludedRows };
}
