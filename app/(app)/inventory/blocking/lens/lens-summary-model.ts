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
// What is still absolutely forbidden, and is NOT done here: a weighted average.
//
// ── ⚠️ THE SUBTOTAL'S LAB CELLS FILLED IN — BY SQL, NOT BY THIS FILE (2026-09-22) ──
// They used to be BLANK, and this module's own header said why: *"a kg-weighted MC over a
// partition SQL never computed would be a second definition of a lab average living in
// TypeScript."* The owner asked for the figures; so `fn_blocking_price_lens` gained
// `warehouse_subtotals[]` — one row per (band × warehouse) carrying the seven kg-weighted
// lab means and the weighted ₱/kg — and the cells are now a LOOKUP of that array
// (migration `20260922093000`). **The rule did not move: the print may RENDER a figure, it
// still must not COMPUTE one.** `buildLensGroupFigures` below formats what SQL published
// and nothing else; there is still no multiplication by a kilogram anywhere in this file,
// and a group the payload has no row for still prints blank rather than a guess.
//
// PURE: no React, no fetch, no server action.
// ─────────────────────────────────────────────────────────────────────────────

import { WAREHOUSES } from '../constants';
import type { BlockData, BlockingLensLabStats } from '../types';
import { LENS_EMDASH } from './lens-shared';

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
  /**
   * The block's DOMINANT supplier, preformatted (`Ornales 71%` on a mixed block, the plain
   * name when it is the whole pile, an em dash with no delivery row at all).
   *
   * Only the PRICE sheet renders a column for it (2026-09-22, the owner's ask): the
   * supplier sheet's per-block column already IS the supplier, and the age sheet has no
   * supplier fact in its payload. Absent ⇒ no column, so those two sheets are unchanged.
   */
  supplier?: string;
}

/**
 * The seven lab cells + the lens's figure for ONE GROUP — a warehouse subtotal or a band
 * total — as strings the sheet prints and does not compute.
 *
 * Each cell is an em dash when the payload published NULL, **never a zero**: the grid
 * COALESCEs its lab averages to 0, so `avg_ash = 0` means "the deliveries carry no ASH
 * figure" and not ash-free charcoal — the L-008 placeholder shape in a lab coat. SQL
 * excludes those blocks from the mean and publishes a real `0` for the coverage WEIGHT,
 * because zero measured kilograms is a measurement.
 */
export interface LensSummaryGroupFigures {
  lab: LensSummaryLab;
  /** The lens's own weighted figure for the group. Em dash on NULL. */
  figure: string;
  /**
   * `ash over 1,203,400 kg` — named ONLY for the stats whose coverage is SHORT of the
   * group's kilograms, and empty when every stat covers all of them.
   *
   * It exists because each stat has its OWN coverage and they genuinely differ: measured
   * 2026-09-22, all 170 occupied blocks carry MC while 11 read 0 on ash, both BDs, grit,
   * VM and FC — a 769,731 kg gap. One shared "lab kg" would be wrong for MC or wrong for
   * the other six on every group in the yard.
   */
  coverageNote: string;
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
  /**
   * The (band × warehouse) group's PUBLISHED lab means and weighted figure, for the
   * SUBTOTAL row. **Absent or null ⇒ every lab cell prints blank**, which is what a lens
   * whose payload carries no such partition (age, supplier) gets — and what a price lens
   * gets for a group SQL emitted no row for.
   */
  figures?: LensSummaryGroupFigures | null;
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

/** Which published mean and which published coverage weight each column reads. */
const LAB_STAT_KEYS: Record<
  LensSummaryLabKey,
  { mean: keyof BlockingLensLabStats; weight: keyof BlockingLensLabStats; decimals: 2 | 3 }
> = {
  mc: { mean: 'wMc', weight: 'mcKg', decimals: 2 },
  ash: { mean: 'wAsh', weight: 'ashKg', decimals: 2 },
  bdAstm: { mean: 'wBdAstm', weight: 'bdAstmKg', decimals: 3 },
  bdJis: { mean: 'wBdJis', weight: 'bdJisKg', decimals: 3 },
  grit: { mean: 'wGrit', weight: 'gritKg', decimals: 2 },
  vm: { mean: 'wVm', weight: 'vmKg', decimals: 2 },
  fc: { mean: 'wFc', weight: 'fcKg', decimals: 2 },
};

/**
 * Format one group's PUBLISHED seven means, its figure, and a coverage note.
 *
 * **It reads. It does not weight.** Every mean is `stats.w<Stat>` verbatim, and the only
 * arithmetic is a COMPARISON — is this stat's coverage weight short of the group's
 * kilograms — plus the Excel Standard's decimals. A `<` is not an average, and there is
 * deliberately no multiplication and no division in this function at all.
 *
 * `groupKg` is the group's own kilograms, the same weight the payload's `kgWeighted…`
 * figures use, so the money column and the seven lab columns on one row describe the same
 * charcoal.
 */
export function buildLensGroupFigures(
  stats: BlockingLensLabStats,
  groupKg: number,
  figure: string,
  formatKg: (n: number) => string,
): LensSummaryGroupFigures {
  const lab = {} as LensSummaryLab;
  const short: string[] = [];
  for (const key of LENS_SUMMARY_LAB_KEYS) {
    const spec = LAB_STAT_KEYS[key];
    const mean = stats[spec.mean] as number | null;
    const weight = stats[spec.weight] as number;
    lab[key] = mean === null ? LENS_EMDASH : (spec.decimals === 3 ? lab3(mean) : lab2(mean));
    // A stat whose mean exists but covers FEWER kilograms than the group is the case a
    // reader has to be told about; one with no mean at all already prints an em dash, and
    // saying "0 kg" beside it would be noise.
    if (mean !== null && weight < groupKg) {
      short.push(`${LENS_SUMMARY_LAB_LABELS[key].toLowerCase()} over ${formatKg(weight)}`);
    }
  }
  return { lab, figure, coverageNote: short.join(' · ') };
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
  /**
   * The block's DOMINANT supplier cell, preformatted. Omit for a lens with no supplier
   * fact in its payload — the sheet then renders no supplier column at all.
   */
  supplierOf?: (blockLoc: string, block: BlockData) => string;
  /**
   * The PUBLISHED figures for one (band × warehouse) group, or null when the payload has
   * no row for that pair. A LOOKUP; this module never builds one.
   */
  figuresOf?: (bandIndex: number, warehouseKey: string) => LensSummaryGroupFigures | null;
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
    const supplier = input.supplierOf?.(loc, block);
    const band = bandOf(loc);
    if (band === undefined) {
      excludedRows.push({
        blockLoc: loc,
        batchCode: block.batch_code,
        kg: formatKg(block.balance),
        figure: input.excludedFigure,
        lab,
        supplier,
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
        supplier,
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
        // A LOOKUP of the payload's own (band × warehouse) row. Null ⇒ blank cells.
        figures: input.figuresOf?.(band, key) ?? null,
      });
    }
    byBand.set(band, groups);
  }

  return { byBand, excludedRows };
}
