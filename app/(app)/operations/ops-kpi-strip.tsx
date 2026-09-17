'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  type OpsCampaign,
  type OpsCampaignRollup,
  type OpsGroupRollup,
} from '@/lib/operations/types';
import { UnitValue } from '@/components/shared/unit-value';
import {
  OpsBlocksTable,
  blocksTableWidth,
  campaignBlockRows,
  campaignBlocksFooter,
  groupBlockRows,
  groupBlocksFooter,
  type OpsBlocksRow,
} from './ops-blocks-table';
import { OpsPrintControl, type OpsPrintSheetSpec } from './ops-print-sheet';
import {
  OpsProductionTables,
  productionRowFromCampaign,
  productionRowFromGroup,
  productionTablesWidth,
} from './ops-production-table';
import { OpsRcMovementModal, type OpsRcCampaignTab } from './ops-rc-movement-modal';
import { TONE, type OpsTone } from './ops-color';
import {
  count,
  hours,
  kg,
  php,
  pctFromFraction,
  pctFromPercent,
  pctNumFromFraction,
  tons,
} from './ops-format';
import { OpsKpiModal, type KpiDetail, type KpiResultTile } from './ops-kpi-modal';

// ═════════════════════════════════════════════════════════════════════════════════
// THE EOQ ROLLUP — Renzo's `EOQ3 2026` tab, as a table. ONE ROW PER CAMPAIGN, plus
// the GROUP row when more than one is picked.
//
// ── ELEVEN COLUMNS, IN HIS ORDER, AND NOTHING ELSE (2026-09-15, round 2) ────────
//   RC Fed · Produced · Yield · Loss · Waste Loss · Fed Price · Actual Fed Price ·
//   Resiko Cost · Resiko Loss · PC Cost · True PC Cost
//
// **THE SUB-CAPTIONS ARE GONE.** Every cell used to carry a small line under it —
// *"24 feed days"*, *"100.0% priced"*, *"whole-block 48.26"*, *"delivered basis"*,
// *"carries the shrinkage"*. Renzo: *"too wordy."* He is right, and the fix is not to
// delete the information: **every cell is now a BUTTON and opens the math** — the
// definition in words and in symbols, each input with its published value, the
// result, and the coverage. What used to be nine cramped captions is one modal per
// figure, which can afford to be complete.
//
// ── THE RESIKO PAIR BECAME ITS OWN TWO COLUMNS (2026-09-15, round 2) ────────────
// Renzo: *"the KPI is wide enough to separate resiko cost and resiko loss as their
// own separate columns. This would make the KPI thinner and give more vertical space
// for the breakdown table."* ACTUAL FED PRICE used to stack three figures in one
// 138px cell — the price, the `upliftPhpKg` under it, the `blockResikoLossPct` under
// that — which set the height of EVERY row in the strip at three lines. Split out,
// each of the three gets a full-width cell, its own header and **its own modal**,
// and the strip costs the ledger one line instead of three.
//
// **RESIKO LOSS IS THE ONE OF THE THREE THAT SURVIVES THE PRICE GATE.**
// `blockResikoLossPct` is a weight ratio — no ₱ in it and none derivable — so it is
// NOT flagged `price` and Production still sees the yard's shrinkage even though it
// may not see what that shrinkage cost. It is drawn in the amber LOSS hue rather
// than the violet MONEY one, which says the same thing in colour.
//
// ONE cell still carries a second line, because the second line IS the figure:
// WASTE LOSS is kg AND a percent of PRODUCED kg (Renzo, 2026-09-15 — what the plant
// sweeps up came OUT of the retort, so it is a property of the output).
//
// ── THE UNIT IS PINNED LEFT, THE DIGITS KEEP THE RIGHT EDGE ─────────────────────
// Every cell renders through the platform `UnitValue` (`components/shared/`, moved
// out of `/analytics` in this same change) — `t` · `%` · `kg` · `₱/kg` in muted 11px
// on the left, the `tabular-nums` figure hard against the right. That is CLAUDE.md's
// Currency (Accounting format) rule generalised, and it is why the column headers
// no longer carry a unit sub-label: the cell already says it, on every row, at a
// fixed x. **An ABSENT figure drops the glyph with the number** — a lone `%` beside
// an em-dash claims a unit for a figure that does not exist.
//
// ── THREE THINGS THIS COMPONENT MUST NOT DO, AND DOES NOT ───────────────────────
//
//  1. **It computes nothing** — here or in the modal builders. Every cell, and every
//     line of every `KpiDetail`, is a FIELD of the rollup the group RPC or the
//     campaign KPI view produced. `a ÷ b = c` in a modal is three separate published
//     fields printed side by side, never a division. The GROUP row is `data.group` —
//     never a fold of the campaign rows — because every ₱/kg and every ratio in it
//     is WEIGHTED in SQL and the mean of three yields belongs to no quarter.
//  2. **It never prints a ₱ it was not given.** `canViewPrices` drops the FIVE ₱
//     columns from the coordinate space (the RC Movement precedent); the server has
//     already nulled the fields, so this is the render guard, not the gate. RESIKO
//     LOSS is deliberately not one of them.
//  3. **It never fills in TRUE PC COST.** Strict NULL unless every block a campaign
//     fed is CLOSED and fully priced — and for a group unless EVERY campaign is. The
//     cell prints `—`; the modal says which blocks (or campaigns) are short, and for
//     the group prints `phpPerProducedKgTrueCovered` as the honest partial, labelled.
//
// ── ROUND 3 (2026-09-15): THE CAMPAIGN CELL LOST ITS DATE LINE, AND FOUR MODALS
//    BECAME A TABLE ─────────────────────────────────────────────────────────────
// *"The date range under the campaign name is kind of needless."* It is — the ledger
// under the strip states every date of every campaign, so the cell is the NAME. The
// GROUP row keeps one line (`3 campaigns`), because how many campaigns is what that
// row IS and nothing else on screen says it.
//
// And FED PRICE / ACTUAL FED PRICE / RESIKO COST / RESIKO LOSS now render the BLOCKS
// USED table instead of an inputs list: *"those two KPI pop ups should portray the
// data in table form so the user can distinguish and get a quick look and a breakdown
// of why the price is the way it is and what the actual price is and why."* The rows
// come from `OpsCampaign.blocks` / `OpsGroupRollup.blocks` — which is why the strip
// takes `campaigns` as well as `rollups`, and reads it for NOTHING else.
//
// ── TWO FIGURES THE GROUP DELIBERATELY DOES NOT HAVE ────────────────────────────
// A block can be fed by more than one campaign (measured: 78 of 523), so summing
// per-campaign resiko kg would charge one block's whole-life shrinkage once per
// campaign. The group publishes the fed-kg-weighted RATIO and no kg, and the
// campaign-attributed actual price and no whole-block one. Both blanks are explained
// in the modal rather than reading as missing data.
// ═════════════════════════════════════════════════════════════════════════════════

/** One value: its unit, its digits, and the extra line(s) that ARE part of the figure. */
interface Figure {
  /** The unit pinned LEFT. EMPTY when the value is absent — see {@link DASH}. */
  glyph: string;
  /** The formatted number, or an em-dash. */
  value: string;
}

interface Cell extends Figure {
  extra?: Figure[];
  /** Muted — the value is legitimately absent, never "no data". */
  absent?: boolean;
}

/**
 * WHAT A DETAIL BUILDER NEEDS BESIDE ITS ROLLUP.
 *
 * The BLOCKS USED rows hang off `OpsCampaign` / `OpsGroupRollup`, not off the money
 * rollup — they are a fact about the campaign that TWO different modals read — so the
 * strip is handed them rather than re-deriving which blocks a campaign fed.
 */
export interface OpsKpiDetailCtx {
  /** campaignKey → that campaign's blocks, in the payload's own order. */
  blocks: Map<string, OpsBlocksRow[]>;
  /** The group's DISTINCT blocks (one row per block, however many campaigns fed it). */
  groupBlocks: OpsBlocksRow[];
  /**
   * EVERY campaign row in the strip, and the group row.
   *
   * The PRODUCTION modal shows one line per campaign plus the GROUP, and the RC FED
   * modal's tabs are the group's campaigns — both are questions about the whole
   * strip, not about the cell that was clicked, so the whole strip is handed over.
   */
  rollups: readonly OpsCampaignRollup[];
  group: OpsGroupRollup | null;
  canViewPrices: boolean;
}

/**
 * WHAT A CELL OPENS.
 *
 * Ten of the eleven columns open the math sheet. RC FED opens the RC Movement
 * matrix, which is a different component with a different lifecycle (it fetches),
 * so the strip's modal state is a discriminated union rather than one nullable
 * `KpiDetail` — the alternative was a `KpiDetail` carrying a marker that
 * `OpsKpiModal` would have had to branch on, i.e. two modals wearing one type.
 */
type OpsModalState =
  | { kind: 'detail'; detail: KpiDetail }
  | {
      kind: 'rcmovement';
      title: string;
      initialKey: string;
      campaigns: OpsRcCampaignTab[];
      groupNote?: string;
    };

interface KpiColumn {
  key: string;
  label: string;
  width: number;
  tone: OpsTone;
  /** Dropped from the layout entirely when the viewer may not see prices. */
  price?: boolean;
  /**
   * THE INTERRELATED FAMILY this column belongs to.
   *
   * Renzo, 2026-09-16: *"Hovering over one of them highlights all 4 of those KPIs.
   * Since those 4 are interrelated, what pops up should be a table where we can see
   * all 4 of that data."* PRODUCED · YIELD · LOSS · WASTE LOSS share two inputs and
   * re-divide them three ways, so they light together and open ONE modal. They stay
   * FOUR COLUMNS — the ask was to relate them, not to merge them.
   */
  family?: string;
  campaign(r: OpsCampaignRollup): Cell;
  group(g: OpsGroupRollup): Cell;
  /** The math sheet. Absent on a column that opens something else (RC FED). */
  campaignDetail?(r: OpsCampaignRollup, ctx: OpsKpiDetailCtx): KpiDetail;
  groupDetail?(g: OpsGroupRollup, ctx: OpsKpiDetailCtx): KpiDetail;
  /** Overrides {@link campaignDetail} — a modal that is not the math sheet. */
  campaignModal?(r: OpsCampaignRollup, ctx: OpsKpiDetailCtx): OpsModalState;
  groupModal?(g: OpsGroupRollup, ctx: OpsKpiDetailCtx): OpsModalState;
}

/** The family id shared by PRODUCED · YIELD · LOSS · WASTE LOSS. */
const FAMILY_PRODUCTION = 'production';

/**
 * An absent figure: an em-dash and **NO GLYPH**.
 *
 * Dropping the unit with the number is the whole point — `₱/kg —` or `% —` reads as
 * a peso figure or a percentage that happens to be blank, when the truth is that
 * there is no such figure to state (a campaign with no closed block has no actual
 * fed price, not an unknown one). Same reasoning as {@link phpResult}.
 */
const DASH: Cell = { glyph: '', value: '—', absent: true };

/** Kg → tonnes, 1 dp. NULL is {@link DASH}; a recorded 0 prints. */
const tFig = (n: number | null): Cell => (n === null ? DASH : { glyph: 't', value: tons(n) });
/** Integer kilograms. */
const kgFig = (n: number | null): Cell => (n === null ? DASH : { glyph: 'kg', value: kg(n) });
/** A published FRACTION → a bare 2-dp percent under a `%` glyph. */
const pctFig = (f: number | null): Cell =>
  f === null ? DASH : { glyph: '%', value: pctNumFromFraction(f, 2) };
/** ₱/kg in accounting form — the glyph IS the left-pinned symbol. */
const phpFig = (n: number | null): Cell => (n === null ? DASH : { glyph: '₱/kg', value: php(n) });

/**
 * WASTE LOSS — the one cell that is legitimately two lines, because the kilograms
 * and the share of PRODUCED kg are both the figure.
 */
const wasteFig = (wasteKg: number | null, pct: number | null): Cell => ({
  ...kgFig(wasteKg),
  extra: [pctFig(pct)],
});

/**
 * A ₱/kg RESULT TILE. A NULL figure drops the glyph with the number — `₱/kg —`
 * claims a peso figure that does not exist (the {@link DASH} reasoning, applied to
 * the result bar).
 */
const phpTile = (label: string, n: number | null): KpiResultTile => ({
  label,
  glyph: n === null ? '' : '₱/kg',
  value: php(n),
  tone: 'money',
});

/**
 * A FRACTION → a percent TILE, in its own family hue (2026-09-16).
 *
 * Renzo, on the combined `YIELD · LOSS · WASTE %` bar: *"It seems weird keeping them
 * the same colour."* Three figures from three families printed in one hue read as
 * one number; each now carries the colour it carries everywhere else on the screen.
 */
const pctTile = (label: string, f: number | null, tone: OpsTone): KpiResultTile => ({
  label,
  glyph: f === null ? '' : '%',
  value: pctNumFromFraction(f, 2),
  tone,
});

/** A ₱ value, or an em-dash. `label` is a caption the line keeps when the value is null. */
const phpLine = (label: string, n: number | null) =>
  (n === null ? `${label} —` : `${label} ₱${php(n)}`).trim();

const campaignSpan = (r: OpsCampaignRollup) =>
  `${r.firstDate} → ${r.lastDate} · ${count(r.ledgerDays)} days · ${count(r.restDays)} rest`;

const groupSpan = (g: OpsGroupRollup) =>
  `${g.campaignCount} campaigns · ${g.firstDate ?? '—'} → ${g.lastDate ?? '—'} · ${g.ledgerDays} days`;

/**
 * A published COUNT where ZERO IS A CLAIM — `count()` blanks a 0, which is right in a
 * ledger cell and wrong in "3 open": there being none open is the answer.
 */
const n0 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

// ── THE BLOCKS USED COUNTS AND FOOTER TOTALS ──────────────────────────────────
// Every figure below is a PUBLISHED field of the rollup. Nothing counts the rows of
// the table it sits under — a length and a published count are two definitions, and
// the published one is the one the database proves.

const campaignBlockCounts = (r: OpsCampaignRollup) =>
  `${n0(r.blocksFed)} blocks · ${n0(r.blocksClosed)} closed · ${n0(r.blocksOpen)} open · ` +
  `${n0(r.blocksInPrice)} fully priced · ${n0(r.blocksClosedUnpriced)} closed but unpriced · ` +
  // PRICED COVERAGE rode in the old free-text footer, which the aligned `<tfoot>`
  // replaced (2026-09-16). It is not a ₱ column — it is a share of KILOGRAMS — so it
  // belongs on the counts line, which every role sees, rather than being dropped.
  `${pctFromPercent(r.fedPriceCoveragePct, 1)} priced coverage`;

const campaignPriceSetCounts = (r: OpsCampaignRollup) =>
  `${campaignBlockCounts(r)} · ${kg(r.campaignFedKgIncluded)} kg fed inside the price set ` +
  `(${pctFromFraction(r.campaignFedKgIncludedPct, 1)})`;

const groupBlockCounts = (g: OpsGroupRollup) =>
  `${g.blocksFedDistinct} distinct blocks · ${g.blocksClosedDistinct} closed · ` +
  `${g.blocksOpenDistinct} open · ${count(g.blocksFedCampaignSum)} counting each campaign ` +
  `separately · ${pctFromPercent(g.fedPriceCoveragePct, 1)} priced coverage`;

const groupPriceSetCounts = (g: OpsGroupRollup) =>
  `${groupBlockCounts(g)} · ${kg(g.campaignFedKgIncluded)} kg fed inside the price set ` +
  `(${pctFromFraction(g.coveredFedKgShare, 1)})`;

// ── THE PRINTED SUMMARY (2026-09-16) ──────────────────────────────────────────
// Renzo: *"When clicking on one campaign, have the option to print a summary of the
// selected campaign. If clicking on the group row, give the option to print all 3
// SEPARATELY… Make sure the printed summary is NOT WORDY."* So a sheet is exactly
// the title, the span, the counts line, the rows, the aligned footer and the result
// — assembled from the same builders the modal uses, so the paper cannot say
// something the screen does not.

const REPORT_LABEL = { fed: 'FED PRICE', actual: 'ACTUAL FED PRICE' } as const;

function blocksPrintSpec(
  variant: 'fed' | 'actual',
  r: OpsCampaignRollup,
  ctx: OpsKpiDetailCtx,
): OpsPrintSheetSpec {
  return {
    key: r.campaignKey,
    name: r.label,
    title: `${r.label} · ${REPORT_LABEL[variant]}`,
    span: campaignSpan(r),
    variant,
    rows: ctx.blocks.get(r.campaignKey) ?? [],
    counts: variant === 'fed' ? campaignBlockCounts(r) : campaignPriceSetCounts(r),
    footer: campaignBlocksFooter(r),
    results:
      variant === 'fed'
        ? [phpTile('Fed price', r.fedPhpKg)]
        : [phpTile('Actual fed price', r.actualFedPhpKg)],
    canViewPrices: ctx.canViewPrices,
  };
}

/** A GROUP prints ONE SHEET PER CAMPAIGN — never a page of de-duplicated rows. */
const blocksPrintSheets = (variant: 'fed' | 'actual', ctx: OpsKpiDetailCtx) =>
  ctx.rollups.map((r) => blocksPrintSpec(variant, r, ctx));

// ── THE PRODUCTION FAMILY: ONE MODAL FOR FOUR CELLS (2026-09-16) ───────────────
// PRODUCED · YIELD · LOSS · WASTE LOSS are one reading — `yieldPct` is produced ÷
// fed, `processLossPct` is 1 − yield, `wasteLossPct` is waste ÷ PRODUCED. Four
// cells over two inputs. Whichever of them is clicked, the SAME modal opens, so a
// reader answers the whole question once instead of four times.
//
// The table shows every campaign in the strip (plus the GROUP row when there is
// one), because the comparison down a quarter is the reason the four are read at
// all. Its rows are the payload's own rollups — the GROUP row is `data.group`, never
// a fold of the three above it.

/** The three definitions, on one line. The modal's `symbols`. */
const PRODUCTION_SYMBOLS =
  'Yield = Produced ÷ RC Fed  ·  Loss = 1 − Yield  ·  Waste % = Waste ÷ Produced';

/**
 * The result bar: the three RATIOS of the row the modal was opened on, as THREE
 * TILES in their own family colours (2026-09-16) — emerald YIELD, amber LOSS, rose
 * WASTE, the hues each of them carries everywhere else on this screen. Three
 * separate published fields printed side by side; the modal has four columns of
 * results and no single headline, so picking one would be a claim about which
 * matters.
 */
const ratioTiles = (r: {
  yieldPct: number | null;
  processLossPct: number | null;
  wasteLossPct: number | null;
}): KpiResultTile[] => [
  pctTile('Yield', r.yieldPct, 'yield'),
  pctTile('Loss', r.processLossPct, 'drift'),
  pctTile('Waste', r.wasteLossPct, 'waste'),
];

/** Every campaign in the strip, then the GROUP row when the group is shown. */
function productionRows(ctx: OpsKpiDetailCtx) {
  const rows = ctx.rollups.map(productionRowFromCampaign);
  if (ctx.group && ctx.rollups.length > 1) rows.push(productionRowFromGroup(ctx.group));
  return rows;
}

function productionDetail(r: OpsCampaignRollup, ctx: OpsKpiDetailCtx): KpiDetail {
  return {
    title: `${r.label} · PRODUCTION`,
    subtitle: campaignSpan(r),
    tone: 'produced',
    symbols: PRODUCTION_SYMBOLS,
    inputs: [],
    contentWidth: productionTablesWidth(),
    table: <OpsProductionTables rows={productionRows(ctx)} />,
    results: ratioTiles(r),
    notes: r.productionReported
      ? undefined
      : [
          'This campaign reported NO production, so PRODUCED, YIELD, LOSS and WASTE % are NULL rather than 0.',
        ],
  };
}

function productionGroupDetail(g: OpsGroupRollup, ctx: OpsKpiDetailCtx): KpiDetail {
  return {
    title: 'GROUP · PRODUCTION',
    subtitle: groupSpan(g),
    tone: 'produced',
    symbols: PRODUCTION_SYMBOLS,
    inputs: [],
    contentWidth: productionTablesWidth(),
    table: <OpsProductionTables rows={productionRows(ctx)} />,
    results: ratioTiles(g),
    notes: [
      `Both denominators are NARROWED to the campaigns that reported: yield over ${kg(g.fedKgProductionReported)} kg fed (${g.campaignsProductionReported} of ${g.campaignCount}), waste over ${kg(g.producedKgWasteReported)} kg produced (${g.campaignsWasteReported} of ${g.campaignCount}).`,
    ],
  };
}

// ── RC FED: THE LINE THAT SITS ABOVE THE MATRIX ────────────────────────────────
// Published fields, printed side by side. `RC Fed = Σ MAIN feedings` is the
// definition the campaign views own (FED = `destination = 'MAIN'`), said in words.

const rcFedNote = (r: OpsCampaignRollup) =>
  `RC Fed = Σ MAIN feedings · ${tons(r.fedKg)} t (${kg(r.fedKg)} kg) · ` +
  `${count(r.feedDays)} feed days · ${count(r.blocksFed)} blocks · sundry ${tons(r.sundryKg)} t`;

const rcFedGroupNote = (g: OpsGroupRollup) =>
  `GROUP · RC Fed = Σ MAIN feedings · ${tons(g.fedKg)} t (${kg(g.fedKg)} kg) · ` +
  `${g.blocksFedDistinct} distinct blocks · ${g.activeDays} active days · sundry ${tons(g.sundryKg)} t`;

const rcTabs = (ctx: OpsKpiDetailCtx): OpsRcCampaignTab[] =>
  ctx.rollups.map((r) => ({ key: r.campaignKey, label: r.label, note: rcFedNote(r) }));

const COLUMNS: KpiColumn[] = [
  // ── RC FED ────────────────────────────────────────────────────────────────────
  {
    key: 'fed',
    label: 'RC Fed',
    width: 96,
    tone: 'fed',
    campaign: (r) => tFig(r.fedKg),
    group: (g) => tFig(g.fedKg),
    // RC FED OPENS THE MATRIX, NOT A MATH SHEET (2026-09-16). The cell is the Σ of
    // exactly the cells `/inventory/rc-movement` prints for this campaign — one
    // relation, two screens — so the honest breakdown of it IS that matrix, day by
    // day and block by block. The five-line inputs list it replaced said less than
    // the line now printed above the grid.
    campaignModal: (r) => ({
      kind: 'rcmovement',
      title: `${r.label} · RC FED`,
      initialKey: r.campaignKey,
      campaigns: [{ key: r.campaignKey, label: r.label, note: rcFedNote(r) }],
    }),
    groupModal: (g, ctx) => ({
      kind: 'rcmovement',
      title: 'GROUP · RC FED',
      // ONE CAMPAIGN AT A TIME, with tabs. Three matrices stacked in one dialog
      // would be three tall grids fighting for one viewport, and the RC Movement
      // views publish a matrix per CAMPAIGN — there is no group-grain matrix to
      // render even if the room existed.
      initialKey: ctx.rollups[0]?.campaignKey ?? g.campaignKeys[0] ?? '',
      campaigns: rcTabs(ctx),
      groupNote: rcFedGroupNote(g),
    }),
  },

  // ── PRODUCED · YIELD · LOSS · WASTE LOSS — ONE FAMILY, FOUR COLUMNS ──────────
  // They stay four cells (a reader scans four numbers down a quarter), but they
  // HOVER together and they open ONE modal: `productionDetail` shows all four for
  // every campaign in the strip, plus the eight waste streams underneath.
  {
    key: 'produced',
    label: 'Produced',
    width: 96,
    tone: 'produced',
    family: FAMILY_PRODUCTION,
    campaign: (r) => (r.productionReported ? tFig(r.producedKg) : DASH),
    group: (g) => tFig(g.producedKg),
    campaignDetail: productionDetail,
    groupDetail: productionGroupDetail,
  },

  {
    key: 'yield',
    label: 'Yield',
    width: 86,
    tone: 'yield',
    family: FAMILY_PRODUCTION,
    campaign: (r) => pctFig(r.yieldPct),
    group: (g) => pctFig(g.yieldPct),
    campaignDetail: productionDetail,
    groupDetail: productionGroupDetail,
  },

  {
    key: 'loss',
    label: 'Loss',
    width: 86,
    tone: 'drift',
    family: FAMILY_PRODUCTION,
    campaign: (r) => pctFig(r.processLossPct),
    group: (g) => pctFig(g.processLossPct),
    campaignDetail: productionDetail,
    groupDetail: productionGroupDetail,
  },

  {
    key: 'waste',
    label: 'Waste Loss',
    width: 112,
    tone: 'waste',
    family: FAMILY_PRODUCTION,
    campaign: (r) => wasteFig(r.wasteKg, r.wasteLossPct),
    group: (g) => wasteFig(g.wasteKg, g.wasteLossPct),
    campaignDetail: productionDetail,
    groupDetail: productionGroupDetail,
  },

  // ── FED PRICE ─────────────────────────────────────────────────────────────────
  // THE MODAL IS THE BLOCKS USED TABLE (2026-09-15, round 3). Renzo asked for the
  // rows behind the price rather than a paragraph about it: which block, when it
  // opened, when it closed, how much of it THIS campaign ate, and what it cost.
  {
    key: 'fedprice',
    label: 'Fed Price',
    width: 108,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.fedPhpKg),
    group: (g) => phpFig(g.fedPhpKg),
    campaignDetail: (r, ctx) => ({
      title: `${r.label} · FED PRICE`,
      subtitle: campaignSpan(r),
      tone: 'money',
      symbols: 'Fed Price = ₱ paid ÷ RC Fed',
      inputs: [],
      contentWidth: blocksTableWidth('fed', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="fed"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignBlockCounts(r)}
          footer={campaignBlocksFooter(r)}
        />
      ),
      results: [phpTile('Fed Price', r.fedPhpKg)],
      actions: (
        <OpsPrintControl sheets={[blocksPrintSpec('fed', r, ctx)]} reportLabel={REPORT_LABEL.fed} />
      ),
    }),
    groupDetail: (g, ctx) => ({
      title: 'GROUP · FED PRICE',
      subtitle: groupSpan(g),
      tone: 'money',
      symbols: 'Fed Price = Σ ₱ paid ÷ Σ fed kg',
      inputs: [],
      contentWidth: blocksTableWidth('fed', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="fed"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupBlockCounts(g)}
          footer={groupBlocksFooter(g)}
        />
      ),
      results: [phpTile('Fed Price', g.fedPhpKg)],
      actions: (
        <OpsPrintControl sheets={blocksPrintSheets('fed', ctx)} reportLabel={REPORT_LABEL.fed} />
      ),
      notes: [
        'FED WT is the kilograms the GROUP drew from each block — one row per DISTINCT block, so a block two campaigns fed appears once and its kilos are not counted twice.',
      ],
    }),
  },

  // ── ACTUAL FED PRICE ──────────────────────────────────────────────────────────
  // The same twelve-column table the RESIKO pair reads, because the three figures are
  // three columns of ONE breakdown: what a block cost on arrival, what it cost by the
  // time it reached the retort, and the weight that went missing in between.
  {
    key: 'actual',
    label: 'Actual Fed Price',
    width: 118,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.actualFedPhpKg),
    group: (g) => phpFig(g.actualFedPhpKg),
    campaignDetail: (r, ctx) => ({
      title: `${r.label} · ACTUAL FED PRICE`,
      subtitle: campaignSpan(r),
      tone: 'money',
      symbols: 'Actual Fed Price = whole-block ₱ ÷ whole-block fed kg',
      inputs: [],
      contentWidth: blocksTableWidth('actual', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignPriceSetCounts(r)}
          footer={campaignBlocksFooter(r)}
        />
      ),
      results: [phpTile('Actual Fed Price', r.actualFedPhpKg)],
      actions: (
        <OpsPrintControl
          sheets={[blocksPrintSpec('actual', r, ctx)]}
          reportLabel={REPORT_LABEL.actual}
        />
      ),
      notes: [
        'A greyed row is outside the price set and says why on hover — a block must be CLOSED and fully priced before its fed total and its money are both final, and a block with any sun-drying outflow is excluded rather than guessed at.',
      ],
    }),
    groupDetail: (g, ctx) => ({
      title: 'GROUP · ACTUAL FED PRICE',
      subtitle: groupSpan(g),
      tone: 'money',
      symbols: 'Actual Fed Price = Σ (campaign-attributed ₱) ÷ Σ fed kg',
      inputs: [],
      contentWidth: blocksTableWidth('actual', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupPriceSetCounts(g)}
          footer={groupBlocksFooter(g)}
        />
      ),
      results: [phpTile('Actual Fed Price', g.actualFedPhpKg)],
      actions: (
        <OpsPrintControl sheets={blocksPrintSheets('actual', ctx)} reportLabel={REPORT_LABEL.actual} />
      ),
      notes: [
        'The group publishes the CAMPAIGN-ATTRIBUTED price and no whole-block one: a block can be fed by more than one campaign, so summing per-campaign block figures would charge one pile’s whole-life shrinkage twice.',
      ],
    }),
  },

  // ── RESIKO COST ───────────────────────────────────────────────────────────────
  // `upliftPhpKg` — actual minus delivered, per kilogram fed. A ₱ column, so it goes
  // when the viewer may not see prices. It reads the SAME table as ACTUAL FED PRICE:
  // the difference is which footer figure the reader came for.
  {
    key: 'resikocost',
    label: 'Resiko Cost',
    width: 112,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.upliftPhpKg),
    group: (g) => phpFig(g.upliftPhpKg),
    campaignDetail: (r, ctx) => ({
      title: `${r.label} · RESIKO COST`,
      subtitle: campaignSpan(r),
      tone: 'money',
      symbols: 'Resiko Cost = Actual Fed Price − Fed Price',
      inputs: [],
      contentWidth: blocksTableWidth('actual', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignPriceSetCounts(r)}
          footer={campaignBlocksFooter(r)}
        />
      ),
      results: [phpTile('Resiko Cost', r.upliftPhpKg)],
      notes: [
        'RESIKO PRICE is legitimately 0 or NEGATIVE on some blocks — roughly 27% of closed ones — and is not clamped: a block that gained weight back, or whose paperwork was filed late, is a real reading.',
        'It is blank wherever ACTUAL PRICE is, and for the same reasons.',
      ],
    }),
    groupDetail: (g, ctx) => ({
      title: 'GROUP · RESIKO COST',
      subtitle: groupSpan(g),
      tone: 'money',
      symbols: 'Resiko Cost = Actual Fed Price − Fed Price',
      inputs: [],
      contentWidth: blocksTableWidth('actual', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupPriceSetCounts(g)}
          footer={groupBlocksFooter(g)}
        />
      ),
      results: [phpTile('Resiko Cost', g.upliftPhpKg)],
    }),
  },

  // ── RESIKO LOSS ───────────────────────────────────────────────────────────────
  // `blockResikoLossPct` — a WEIGHT ratio. No ₱ in it and none derivable, so it is
  // NOT `price`-flagged and Production keeps it; amber, not violet, says the same.
  // Its table is the same one, minus the three ₱ columns for a viewer without price
  // rights — which is exactly what makes it safe to open at every role.
  {
    key: 'resikoloss',
    label: 'Resiko Loss',
    width: 96,
    tone: 'drift',
    campaign: (r) => pctFig(r.blockResikoLossPct),
    group: (g) => pctFig(g.blockResikoLossPct),
    campaignDetail: (r, ctx) => ({
      title: `${r.label} · RESIKO LOSS`,
      subtitle: campaignSpan(r),
      tone: 'drift',
      symbols: 'Resiko Loss = resiko weight ÷ arrival weight, over the blocks in the price set',
      inputs: [],
      contentWidth: blocksTableWidth('actual', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignPriceSetCounts(r)}
          // THE FOOTER NEEDS NO PRICE BRANCH ANY MORE (2026-09-16): it is one
          // cell per column, and the ₱ columns are already absent from the layout
          // for a viewer without price rights.
          footer={campaignBlocksFooter(r)}
        />
      ),
      results: [pctTile('Resiko Loss', r.blockResikoLossPct, 'drift')],
      notes: [
        'RESIKO is measured over CLOSED blocks only: while a block is open the charcoal left in the pile is stock, so the cell shows that BALANCE instead, muted.',
        'This figure carries NO PESO VALUE and none is derivable from it, so it stays on screen for every role — including Production, which may not see what the shrinkage cost. (The glyph is deliberately not written here: the price-denied check asserts the document contains none.)',
      ],
    }),
    groupDetail: (g, ctx) => ({
      title: 'GROUP · RESIKO LOSS',
      subtitle: groupSpan(g),
      tone: 'drift',
      symbols: 'Resiko Loss = weighted over the covered fed kg of the member campaigns',
      inputs: [],
      contentWidth: blocksTableWidth('actual', ctx.canViewPrices),
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupPriceSetCounts(g)}
          footer={groupBlocksFooter(g)}
        />
      ),
      results: [pctTile('Resiko Loss', g.blockResikoLossPct, 'drift')],
      notes: [
        'THE GROUP PUBLISHES NO RESIKO KILOGRAMS — a block can be fed by more than one campaign (78 of 523), so adding per-campaign resiko weights would charge one pile’s whole-life shrinkage once per campaign that touched it. The ratio is weighted instead, which does not double-count.',
      ],
    }),
  },

  // ── PC COST ───────────────────────────────────────────────────────────────────
  {
    key: 'pccost',
    label: 'PC Cost',
    width: 108,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.phpPerProducedKgDelivered),
    group: (g) => phpFig(g.phpPerProducedKgDelivered),
    campaignDetail: (r) => ({
      title: `${r.label} · PC COST`,
      subtitle: campaignSpan(r),
      tone: 'money',
      symbols: 'PC Cost = Fed Price ÷ Yield',
      inputs: [
        { label: 'Fed Price (delivered)', value: phpLine('', r.fedPhpKg) },
        { label: 'Yield', value: pctFromFraction(r.yieldPct, 2) },
        { label: 'RC Fed', value: `${kg(r.fedKg)} kg` },
        { label: 'Produced', value: `${kg(r.producedKg)} kg` },
      ],
      results: [phpTile('PC Cost', r.phpPerProducedKgDelivered)],
      notes: [
        'DELIVERED basis — it does not carry the yard’s shrinkage. The figure that does is TRUE PC COST beside it.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · PC COST',
      subtitle: groupSpan(g),
      tone: 'money',
      symbols: 'PC Cost = Fed Price ÷ Yield',
      inputs: [
        { label: 'Fed Price (delivered)', value: phpLine('', g.fedPhpKg) },
        { label: 'Yield', value: pctFromFraction(g.yieldPct, 2) },
        { label: 'RC Fed', value: `${kg(g.fedKg)} kg` },
        { label: 'Produced', value: `${kg(g.producedKg)} kg` },
      ],
      results: [phpTile('PC Cost', g.phpPerProducedKgDelivered)],
    }),
  },

  // ── TRUE PC COST ──────────────────────────────────────────────────────────────
  {
    key: 'truepc',
    label: 'True PC Cost',
    width: 116,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.phpPerProducedKgTrue),
    group: (g) => phpFig(g.phpPerProducedKgTrue),
    campaignDetail: (r) => ({
      title: `${r.label} · TRUE PC COST`,
      subtitle: campaignSpan(r),
      tone: 'money',
      symbols: 'True PC Cost = Actual Fed Price ÷ Yield',
      inputs: [
        { label: 'Actual Fed Price', value: phpLine('', r.campaignWeightedActualFedPhpKg) },
        { label: 'Yield', value: pctFromFraction(r.yieldPct, 2) },
        { label: 'PC Cost (delivered basis)', value: phpLine('', r.phpPerProducedKgDelivered) },
        { label: 'Blocks closed', value: `${count(r.blocksClosed)} of ${count(r.blocksFed)}` },
        { label: 'Blocks fully priced', value: count(r.blocksInPrice) },
        { label: 'Closed but unpriced', value: count(r.blocksClosedUnpriced) },
      ],
      results: [phpTile('True PC Cost', r.phpPerProducedKgTrue)],
      notes:
        r.phpPerProducedKgTrue === null
          ? [
              `BLANK ON PURPOSE. It is published only when EVERY block this campaign fed is closed AND fully priced — here ${count(r.blocksClosed)} of ${count(r.blocksFed)} are closed and ${count(r.blocksInPrice)} are fully priced.`,
              'A partial answer would be understated in exactly the direction the figure exists to expose, so the database publishes NULL instead of a number that points the wrong way.',
            ]
          : undefined,
    }),
    groupDetail: (g) => ({
      title: 'GROUP · TRUE PC COST',
      subtitle: groupSpan(g),
      tone: 'money',
      symbols: 'True PC Cost = Actual Fed Price ÷ Yield',
      inputs: [
        { label: 'Actual Fed Price', value: phpLine('', g.actualFedPhpKg) },
        { label: 'Yield', value: pctFromFraction(g.yieldPct, 2) },
        { label: 'PC Cost (delivered basis)', value: phpLine('', g.phpPerProducedKgDelivered) },
        {
          label: 'Covered partial',
          value: phpLine('', g.phpPerProducedKgTrueCovered),
          note: 'over the campaigns that ARE fully covered',
        },
        {
          label: 'Campaigns fully covered',
          value: `${g.campaignsFullyCovered} of ${g.campaignCount}`,
        },
        { label: 'Share of fed kg that is covered', value: pctFromFraction(g.coveredFedKgShare, 1) },
      ],
      results: [phpTile('True PC Cost', g.phpPerProducedKgTrue)],
      notes:
        g.phpPerProducedKgTrue === null
          ? [
              `BLANK ON PURPOSE — ${g.campaignsFullyCovered} of ${g.campaignCount} campaigns have every block closed and priced.`,
              g.phpPerProducedKgTrueCovered === null
                ? 'No covered partial is published either, because no member campaign is fully covered.'
                : `The honest partial over the campaigns that ARE covered is ₱${php(g.phpPerProducedKgTrueCovered)}/kg.`,
            ]
          : undefined,
    }),
  },
];

const W_LABEL = 150;

/**
 * Excel Standard `h-8`, as a table row MINIMUM.
 *
 * It is the point of the split: eleven single-line cells instead of nine cells one
 * of which was three lines tall. WASTE LOSS is still two lines (the kilograms and
 * the share of produced ARE both the figure), so that row settles a few pixels
 * over 32 — a `<tr>` height is a floor in the table model, never a clamp, and
 * clamping it would clip the second line rather than shrink it.
 */
const ROW_H = 32;

export interface OpsKpiStripProps {
  /**
   * The campaigns in view — read ONLY for their `blocks`, the BLOCKS USED table the
   * FED PRICE / ACTUAL FED PRICE / RESIKO modals render. Every number in the strip
   * still comes from `rollups` / `group`.
   */
  campaigns: readonly OpsCampaign[];
  rollups: readonly OpsCampaignRollup[];
  group: OpsGroupRollup | null;
  canViewPrices: boolean;
  className?: string;
}

export function OpsKpiStrip({
  campaigns,
  rollups,
  group,
  canViewPrices,
  className,
}: OpsKpiStripProps) {
  const cols = React.useMemo(
    () => COLUMNS.filter((c) => canViewPrices || !c.price),
    [canViewPrices],
  );
  // A RESHAPE, not a computation: the payload's own rows, keyed by campaign, with the
  // one field that differs between the campaign and group shapes normalised.
  const ctx = React.useMemo<OpsKpiDetailCtx>(
    () => ({
      blocks: new Map(campaigns.map((c) => [c.key, campaignBlockRows(c.blocks)])),
      groupBlocks: group ? groupBlockRows(group.blocks) : [],
      rollups,
      group,
      canViewPrices,
    }),
    [campaigns, rollups, group, canViewPrices],
  );
  const [modal, setModal] = React.useState<OpsModalState | null>(null);

  // RESOLVED ON CLICK, NOT ON RENDER. A `KpiDetail` carries a whole React element
  // (the BLOCKS USED table, the PRODUCTION tables), so building eleven of them for
  // every row on every render was eleven tables per campaign that nobody was
  // looking at. The handler takes the column INDEX and builds exactly one.
  const openCampaign = React.useCallback(
    (r: OpsCampaignRollup, col: KpiColumn) => {
      const direct = col.campaignModal?.(r, ctx);
      if (direct) return setModal(direct);
      const detail = col.campaignDetail?.(r, ctx);
      if (detail) setModal({ kind: 'detail', detail });
    },
    [ctx],
  );
  const openGroup = React.useCallback(
    (g: OpsGroupRollup, col: KpiColumn) => {
      const direct = col.groupModal?.(g, ctx);
      if (direct) return setModal(direct);
      const detail = col.groupDetail?.(g, ctx);
      if (detail) setModal({ kind: 'detail', detail });
    },
    [ctx],
  );

  const showGroup = group !== null && rollups.length > 1;
  const minWidth = W_LABEL + cols.reduce((sum, c) => sum + c.width, 0);

  if (rollups.length === 0) return null;

  return (
    <section className={cn('flex flex-col gap-1', className)} aria-label="Campaign rollup">
      {/* NEVER CRUSH, ALWAYS SCROLL — an explicit min-width equal to the sum of the
          column widths, inside an `overflow-x-auto` wrapper. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="table-fixed text-xs" style={{ width: '100%', minWidth }}>
          <colgroup>
            <col style={{ width: W_LABEL }} />
            {cols.map((c) => (
              <col key={c.key} style={{ width: c.width }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="border-b border-r border-border bg-muted px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Campaign
              </th>
              {cols.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'border-t-2 border-r border-b border-border px-2 py-1 text-right align-bottom text-[10px] font-semibold uppercase tracking-wide',
                    TONE[c.tone].head,
                    TONE[c.tone].edge,
                  )}
                >
                  {/* NO UNIT SUB-LABEL — the cell states its unit on every row, at a
                      fixed x, through `UnitValue`. Saying it twice costs a header
                      line and buys nothing. */}
                  <span className="block truncate">{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rollups.map((r) => (
              <Row
                key={r.campaignKey}
                title={r.label}
                cells={cols.map((c) => c.campaign(r))}
                cols={cols}
                onOpen={(col) => openCampaign(r, col)}
              />
            ))}
            {showGroup ? (
              <Row
                lead
                title="GROUP"
                subtitle={`${group.campaignCount} campaigns`}
                cells={cols.map((c) => c.group(group))}
                cols={cols}
                onOpen={(col) => openGroup(group, col)}
              />
            ) : null}
          </tbody>
        </table>
      </div>

      {/* The rest of the EOQ tab — figures that are CHECKED rather than watched, so
          one dense line rather than seven more columns. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
        {showGroup ? (
          <>
            <span>SHIFTS {count(group.shiftCount)}</span>
            <span>RUNS {count(group.runCount)}</span>
            <span>DOWNTIME {hours(group.downtimeHours)} h</span>
            <span>SACKS {count(group.sacks)}</span>
            <span>REST DAYS {count(group.restDays)}</span>
            <span>
              BLOCKS {group.blocksClosedDistinct} closed / {group.blocksOpenDistinct} open
            </span>
            <span>SUNDRY {tons(group.sundryKg)} t</span>
          </>
        ) : (
          rollups.map((r) => (
            <React.Fragment key={r.campaignKey}>
              <span>SHIFTS {count(r.shiftCount)}</span>
              <span>RUNS {count(r.runCount)}</span>
              <span>DOWNTIME {hours(r.downtimeHours)} h</span>
              <span>SACKS {count(r.sacks)}</span>
              <span>REST DAYS {count(r.restDays)}</span>
              <span>
                BLOCKS {count(r.blocksClosed)} closed / {count(r.blocksOpen)} open
              </span>
              <span>SUNDRY {tons(r.sundryKg)} t</span>
            </React.Fragment>
          ))
        )}
      </div>

      <OpsKpiModal
        detail={modal?.kind === 'detail' ? modal.detail : null}
        onClose={() => setModal(null)}
      />
      {modal?.kind === 'rcmovement' ? (
        // KEYED BY THE CAMPAIGN IT OPENED ON, so re-opening from a different cell
        // remounts with a fresh tab selection instead of needing a state-sync
        // effect to push `initialKey` into the component.
        <OpsRcMovementModal
          key={modal.initialKey}
          title={modal.title}
          campaigns={modal.campaigns}
          initialKey={modal.initialKey}
          groupNote={modal.groupNote}
          onClose={() => setModal(null)}
        />
      ) : null}
    </section>
  );
}

function Row({
  title,
  subtitle,
  cells,
  cols,
  lead,
  onOpen,
}: {
  title: string;
  /**
   * OPTIONAL, AND ABSENT ON A CAMPAIGN ROW (Renzo, 2026-09-15 round 3: the date range
   * under the name is *"kind of needless"* — the ledger below states every date). The
   * GROUP row keeps one line, because *how many campaigns* is what the row IS.
   */
  subtitle?: string;
  cells: Cell[];
  cols: KpiColumn[];
  lead?: boolean;
  onOpen(col: KpiColumn): void;
}) {
  /**
   * THE FAMILY UNDER THE POINTER (2026-09-16).
   *
   * Renzo: *"Hovering over one of them highlights all 4 of those KPIs."* So a cell
   * that belongs to a family publishes that family while it is hovered OR focused,
   * and every cell of the same family in THIS ROW lights with it. Per-row, because
   * the row is the campaign and the relationship between the four numbers is a
   * statement about one campaign — lighting the whole column block across three
   * campaigns would say something the data does not.
   *
   * `onFocus` / `onBlur` as well as the pointer, so a keyboard reader tabbing along
   * the strip sees exactly what a mouse reader sees.
   */
  const [family, setFamily] = React.useState<string | null>(null);

  return (
    <tr
      style={{ height: ROW_H }}
      className={cn(
        'border-b border-border/60 transition-all duration-150 last:border-b-0 hover:bg-muted/30',
        lead && 'bg-muted/40',
      )}
    >
      <td className="border-r border-border px-2 py-0.5 align-middle">
        <span className={cn('block truncate text-[11px]', lead ? 'font-semibold' : 'font-medium')}>
          {title}
        </span>
        {subtitle ? (
          <span className="block truncate font-mono text-[10px] leading-tight tabular-nums text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </td>
      {cells.map((cell, i) => {
        const col = cols[i];
        const lit = col.family !== undefined && col.family === family;
        return (
        <td
          key={col.key}
          onMouseEnter={() => setFamily(col.family ?? null)}
          onMouseLeave={() => setFamily(null)}
          className={cn(
            'border-r border-border/60 p-0 align-middle transition-colors duration-150',
            // THE SHARED BAND. Compositor-cheap (background + inset ring), applied
            // to every cell of the family at once so the four read as one group.
            lit && 'bg-accent/70 ring-1 ring-inset ring-ring/40',
          )}
        >
          {/* EVERY CELL IS A BUTTON — full-cell hit area, real button semantics and a
              visible focus ring, so the math is reachable from the keyboard. */}
          <button
            type="button"
            aria-haspopup="dialog"
            title={
              col.family === FAMILY_PRODUCTION
                ? `${title} · ${col.label} — Produced, Yield, Loss and Waste Loss are one reading; open all four`
                : col.key === 'fed'
                  ? `${title} · ${col.label} — open the RC Movement matrix`
                  : `${title} · ${col.label} — show the math`
            }
            onFocus={() => setFamily(col.family ?? null)}
            onBlur={() => setFamily(null)}
            onClick={() => onOpen(col)}
            className={cn(
              // `flex min-h` rather than padding: the hit area stays the full row
              // height while the two-line WASTE LOSS cell keeps the row at `h-8`.
              'flex min-h-[30px] w-full flex-col justify-center px-2 py-0.5 text-right transition-colors duration-150',
              'hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
            )}
          >
            {/* UNIT LEFT, DIGITS RIGHT — one component, so the eleven columns cannot
                drift in size, colour or spacing. */}
            <UnitValue
              glyph={cell.glyph}
              className="leading-tight"
              valueClassName={cn(
                'font-mono text-xs tabular-nums',
                cell.absent ? 'text-muted-foreground' : cn('font-medium', TONE[col.tone].text),
                lead && !cell.absent && 'font-semibold',
              )}
            >
              {cell.value || '—'}
            </UnitValue>
            {cell.extra?.map((line, j) => (
              <UnitValue
                key={j}
                glyph={line.glyph}
                className="leading-tight"
                valueClassName="font-mono text-[10px] tabular-nums text-muted-foreground"
                glyphClassName="text-[length:var(--bw-fs-10)]"
              >
                {line.value || '—'}
              </UnitValue>
            ))}
          </button>
        </td>
        );
      })}
    </tr>
  );
}

// ═════════════════════════════════════════════════════════════════════════════════
// THE SAME ELEVEN COLUMNS, AS PLAIN DATA — for the printed report (2026-09-17).
//
// `ops-page-print.tsx` prints the EOQ rollup as page 1 and each campaign's own row as
// that campaign's KPI strip. Both are THIS table, on paper, so they read it from
// {@link COLUMNS} rather than listing eleven fields again — a second list is a second
// definition, and the first time one of them gained a column the two would disagree
// about what the EOQ rollup IS.
//
// It hands back PLAIN DATA (a unit glyph and a formatted string per cell), never a
// React node: the printed sheet is black on white with no tint, no `UnitValue` and no
// button, so sharing the RENDER would mean sharing the screen's chrome too. What is
// shared is the part that must not drift — which columns, in which order, reading
// which published field, formatted how.
//
// NOTHING IS COMPUTED HERE either: every cell is `col.campaign(r)` / `col.group(g)`,
// the identical call the screen makes.
// ═════════════════════════════════════════════════════════════════════════════════

export interface OpsKpiPrintColumn {
  key: string;
  label: string;
}

export interface OpsKpiPrintCell {
  /** The unit — `t` · `%` · `kg` · `₱/kg`. EMPTY when the figure is absent. */
  glyph: string;
  value: string;
  absent: boolean;
  /** WASTE LOSS is legitimately two lines: the kilograms AND the share of produced. */
  extra: { glyph: string; value: string }[];
}

export interface OpsKpiPrintRow {
  /** `JULY 2026`, or `GROUP`. */
  label: string;
  /** `3 campaigns` on the GROUP row, absent on a campaign row. */
  subtitle?: string;
  cells: OpsKpiPrintCell[];
}

const printCell = (c: Cell): OpsKpiPrintCell => ({
  glyph: c.glyph,
  value: c.value,
  absent: c.absent === true,
  extra: (c.extra ?? []).map((e) => ({ glyph: e.glyph, value: e.value })),
});

/**
 * The strip, as rows and columns a printed table can lay out.
 *
 * The GROUP row is included on exactly the condition the screen includes it —
 * `group !== null && rollups.length > 1` — so a one-campaign report never prints a
 * "GROUP" line that restates the only row above it.
 */
export function opsKpiPrintTable(
  rollups: readonly OpsCampaignRollup[],
  group: OpsGroupRollup | null,
  canViewPrices: boolean,
): { columns: OpsKpiPrintColumn[]; rows: OpsKpiPrintRow[] } {
  const cols = COLUMNS.filter((c) => canViewPrices || !c.price);
  const rows: OpsKpiPrintRow[] = rollups.map((r) => ({
    label: r.label,
    cells: cols.map((c) => printCell(c.campaign(r))),
  }));
  if (group !== null && rollups.length > 1) {
    rows.push({
      label: 'GROUP',
      subtitle: `${group.campaignCount} campaigns`,
      cells: cols.map((c) => printCell(c.group(group))),
    });
  }
  return { columns: cols.map((c) => ({ key: c.key, label: c.label })), rows };
}
