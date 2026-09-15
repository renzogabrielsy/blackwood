'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  WASTE_STREAMS,
  type OpsCampaign,
  type OpsCampaignRollup,
  type OpsGroupRollup,
} from '@/lib/operations/types';
import { UnitValue } from '@/components/shared/unit-value';
import {
  OpsBlocksTable,
  campaignBlockRows,
  groupBlockRows,
  type OpsBlocksRow,
} from './ops-blocks-table';
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
import { OpsKpiModal, type KpiDetail, type KpiInput } from './ops-kpi-modal';

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
  canViewPrices: boolean;
}

interface KpiColumn {
  key: string;
  label: string;
  width: number;
  tone: OpsTone;
  /** Dropped from the layout entirely when the viewer may not see prices. */
  price?: boolean;
  campaign(r: OpsCampaignRollup): Cell;
  group(g: OpsGroupRollup): Cell;
  campaignDetail(r: OpsCampaignRollup, ctx: OpsKpiDetailCtx): KpiDetail;
  groupDetail(g: OpsGroupRollup, ctx: OpsKpiDetailCtx): KpiDetail;
}

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
 * A ₱/kg RESULT line. Null prints a bare em-dash, never `₱—/kg` — a currency symbol
 * wrapped around a blank claims a peso figure that does not exist.
 */
const phpResult = (n: number | null) => (n === null ? '—' : `₱${php(n)}/kg`);

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
  `${n0(r.blocksInPrice)} fully priced · ${n0(r.blocksClosedUnpriced)} closed but unpriced`;

const campaignPriceSetCounts = (r: OpsCampaignRollup) =>
  `${campaignBlockCounts(r)} · ${kg(r.campaignFedKgIncluded)} kg fed inside the price set ` +
  `(${pctFromFraction(r.campaignFedKgIncludedPct, 1)})`;

const groupBlockCounts = (g: OpsGroupRollup) =>
  `${g.blocksFedDistinct} distinct blocks · ${g.blocksClosedDistinct} closed · ` +
  `${g.blocksOpenDistinct} open · ${count(g.blocksFedCampaignSum)} counting each campaign separately`;

const groupPriceSetCounts = (g: OpsGroupRollup) =>
  `${groupBlockCounts(g)} · ${kg(g.campaignFedKgIncluded)} kg fed inside the price set ` +
  `(${pctFromFraction(g.coveredFedKgShare, 1)})`;

const fedTotals = (r: OpsCampaignRollup | OpsGroupRollup) => [
  { label: '₱ paid', value: php(r.fedValuePhp) },
  { label: 'RC fed', value: `${kg(r.fedKg)} kg` },
  { label: 'Priced coverage', value: pctFromPercent(r.fedPriceCoveragePct, 1) },
  { label: 'Fed price', value: phpResult(r.fedPhpKg) },
];

const actualTotals = (r: OpsCampaignRollup) => [
  { label: 'Fed price', value: phpResult(r.fedPhpKg) },
  { label: 'Actual fed price', value: phpResult(r.actualFedPhpKg) },
  { label: 'Campaign-attributed', value: phpResult(r.campaignWeightedActualFedPhpKg) },
  { label: 'Resiko cost', value: phpResult(r.upliftPhpKg) },
  { label: 'Resiko loss', value: pctFromFraction(r.blockResikoLossPct, 2) },
  { label: 'Resiko weight', value: `${kg(r.blockResikoKg)} kg` },
];

// THE GROUP HAS NO RESIKO KILOGRAMS AND NO WHOLE-BLOCK ACTUAL PRICE, and the absence
// is the point: a block can be fed by several campaigns, so both would double-count.
const groupActualTotals = (g: OpsGroupRollup) => [
  { label: 'Fed price', value: phpResult(g.fedPhpKg) },
  { label: 'Actual fed price', value: phpResult(g.actualFedPhpKg) },
  { label: 'Resiko cost', value: phpResult(g.upliftPhpKg) },
  { label: 'Resiko loss', value: pctFromFraction(g.blockResikoLossPct, 2) },
];

/** The eight streams as modal inputs. Reading, not summing. */
function wasteInputs(waste: OpsCampaignRollup['waste']): KpiInput[] {
  return WASTE_STREAMS.map((w) => ({ label: w.label, value: kg(waste[w.key]) }));
}

const COLUMNS: KpiColumn[] = [
  // ── RC FED ────────────────────────────────────────────────────────────────────
  {
    key: 'fed',
    label: 'RC Fed',
    width: 96,
    tone: 'fed',
    campaign: (r) => tFig(r.fedKg),
    group: (g) => tFig(g.fedKg),
    campaignDetail: (r) => ({
      title: `${r.label} · RC FED`,
      subtitle: campaignSpan(r),
      tone: 'fed',
      symbols: 'RC Fed = Σ rc_out.weight_kg where destination = MAIN',
      inputs: [
        { label: 'Fed', value: `${kg(r.fedKg)} kg` },
        { label: 'Out of the yard (feeding + sun-drying)', value: `${kg(r.outKg)} kg` },
        { label: 'Pulled out to sun-dry', value: `${kg(r.sundryKg)} kg`, note: 'NOT feed' },
        { label: 'Days the plant was fed', value: count(r.feedDays) },
        { label: 'Blocks drawn from', value: count(r.blocksFed) },
      ],
      result: { label: 'RC Fed', value: `${tons(r.fedKg)} t` },
    }),
    groupDetail: (g) => ({
      title: 'GROUP · RC FED',
      subtitle: groupSpan(g),
      tone: 'fed',
      symbols: 'RC Fed = Σ of the member campaigns’ fed kg',
      inputs: [
        { label: 'Fed', value: `${kg(g.fedKg)} kg` },
        { label: 'Pulled out to sun-dry', value: `${kg(g.sundryKg)} kg` },
        { label: 'Distinct blocks fed', value: String(g.blocksFedDistinct) },
        {
          label: 'Naive Σ of per-campaign block counts',
          value: count(g.blocksFedCampaignSum),
          note: 'larger when a block was fed by two campaigns',
        },
        { label: 'Active days', value: String(g.activeDays) },
      ],
      result: { label: 'RC Fed', value: `${tons(g.fedKg)} t` },
    }),
  },

  // ── PRODUCED ──────────────────────────────────────────────────────────────────
  {
    key: 'produced',
    label: 'Produced',
    width: 96,
    tone: 'produced',
    campaign: (r) => (r.productionReported ? tFig(r.producedKg) : DASH),
    group: (g) => tFig(g.producedKg),
    campaignDetail: (r) => ({
      title: `${r.label} · PRODUCED`,
      subtitle: campaignSpan(r),
      tone: 'produced',
      symbols: 'Produced = Σ production_runs.ttl_kg for the campaign',
      inputs: [
        { label: 'Produced', value: `${kg(r.producedKg)} kg` },
        { label: 'Days production was reported', value: count(r.reportedDays) },
        { label: 'Shifts', value: count(r.shiftCount) },
        { label: 'Runs', value: count(r.runCount) },
        {
          label: 'Sacks',
          value: count(r.sacks),
          note: `${pctFromPercent(r.sacksCoveragePct, 1)} of runs recorded a bag count`,
        },
      ],
      result: { label: 'Produced', value: r.productionReported ? `${tons(r.producedKg)} t` : '—' },
      notes: r.productionReported
        ? undefined
        : [
            'This campaign reported NO production, so the figure is NULL rather than 0 — "nothing was filed" and "nothing was made" are different answers.',
          ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · PRODUCED',
      subtitle: groupSpan(g),
      tone: 'produced',
      symbols: 'Produced = Σ of the member campaigns’ produced kg',
      inputs: [
        { label: 'Produced', value: `${kg(g.producedKg)} kg` },
        {
          label: 'Campaigns that reported production',
          value: `${g.campaignsProductionReported} of ${g.campaignCount}`,
        },
        { label: 'Reported campaign-days', value: count(g.reportedCampaignDays) },
        {
          label: 'Reported calendar days',
          value: String(g.reportedCalendarDays),
          note: 'a changeover date is one calendar day and two campaign-days',
        },
        { label: 'Shifts', value: count(g.shiftCount) },
      ],
      result: { label: 'Produced', value: `${tons(g.producedKg)} t` },
    }),
  },

  // ── YIELD ─────────────────────────────────────────────────────────────────────
  {
    key: 'yield',
    label: 'Yield',
    width: 86,
    tone: 'yield',
    campaign: (r) => pctFig(r.yieldPct),
    group: (g) => pctFig(g.yieldPct),
    campaignDetail: (r) => ({
      title: `${r.label} · YIELD`,
      subtitle: campaignSpan(r),
      tone: 'yield',
      symbols: 'Yield = Produced ÷ RC Fed',
      inputs: [
        { label: 'Produced', value: `${kg(r.producedKg)} kg` },
        { label: 'RC Fed', value: `${kg(r.fedKg)} kg` },
      ],
      result: { label: 'Yield', value: pctFromFraction(r.yieldPct, 2) },
    }),
    groupDetail: (g) => ({
      title: 'GROUP · YIELD',
      subtitle: groupSpan(g),
      tone: 'yield',
      symbols: 'Yield = Produced ÷ fed kg of the campaigns that reported',
      inputs: [
        { label: 'Produced', value: `${kg(g.producedKg)} kg` },
        {
          label: 'Fed kg used as the denominator',
          value: `${kg(g.fedKgProductionReported)} kg`,
          note: 'NOT the group’s whole fed total',
        },
        { label: 'Fed (whole group)', value: `${kg(g.fedKg)} kg` },
        {
          label: 'Campaigns that reported production',
          value: `${g.campaignsProductionReported} of ${g.campaignCount}`,
        },
      ],
      result: { label: 'Yield', value: pctFromFraction(g.yieldPct, 2) },
    }),
  },

  // ── LOSS (%) ──────────────────────────────────────────────────────────────────
  {
    key: 'loss',
    label: 'Loss',
    width: 86,
    tone: 'drift',
    campaign: (r) => pctFig(r.processLossPct),
    group: (g) => pctFig(g.processLossPct),
    campaignDetail: (r) => ({
      title: `${r.label} · PROCESS LOSS`,
      subtitle: campaignSpan(r),
      tone: 'drift',
      symbols: 'Loss = 1 − Yield ·  Loss kg = RC Fed − Produced',
      inputs: [
        { label: 'RC Fed', value: `${kg(r.fedKg)} kg` },
        { label: 'Produced', value: `${kg(r.producedKg)} kg` },
        { label: 'Process loss', value: `${kg(r.processLossKg)} kg` },
        { label: 'Yield', value: pctFromFraction(r.yieldPct, 2) },
      ],
      result: { label: 'Process loss', value: pctFromFraction(r.processLossPct, 2) },
      notes: [
        'This is the RETORT’s loss. The yard’s own shrinkage — evaporation in the pile between arrival and feeding — is the separate RESIKO LOSS column.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · PROCESS LOSS',
      subtitle: groupSpan(g),
      tone: 'drift',
      symbols: 'Loss = 1 − Yield',
      inputs: [
        { label: 'RC Fed', value: `${kg(g.fedKg)} kg` },
        { label: 'Produced', value: `${kg(g.producedKg)} kg` },
        { label: 'Process loss', value: `${kg(g.processLossKg)} kg` },
        { label: 'Yield', value: pctFromFraction(g.yieldPct, 2) },
      ],
      result: { label: 'Process loss', value: pctFromFraction(g.processLossPct, 2) },
    }),
  },

  // ── WASTE LOSS ────────────────────────────────────────────────────────────────
  {
    key: 'waste',
    label: 'Waste Loss',
    width: 112,
    tone: 'waste',
    campaign: (r) => wasteFig(r.wasteKg, r.wasteLossPct),
    group: (g) => wasteFig(g.wasteKg, g.wasteLossPct),
    campaignDetail: (r) => ({
      title: `${r.label} · WASTE LOSS`,
      subtitle: campaignSpan(r),
      tone: 'waste',
      symbols: 'Waste Loss = (TRML 1 + TRML 2 + RS1A + RS1B + RS2/3 + RS5 + BF + GRITS) ÷ Produced',
      inputs: [
        ...wasteInputs(r.waste),
        { label: 'Waste total', value: `${kg(r.wasteKg)} kg` },
        { label: 'Produced', value: `${kg(r.producedKg)} kg`, note: 'the denominator' },
        {
          label: 'Shifts that filed a waste row',
          value: `${r.wasteShiftCount} of ${count(r.shiftCount)}`,
          note: 'the coverage behind the total',
        },
      ],
      result: { label: 'Waste loss', value: pctFromFraction(r.wasteLossPct, 2) },
      notes: [
        'THESE EIGHT DO NOT SUM TO THE PROCESS LOSS above. Most of what the retort loses leaves as moisture and volatiles that nobody weighs; this is what was swept up and weighed.',
        'NULL IS NEVER 0 — a campaign none of whose shifts filed a waste row reads blank on every stream, which is not the same as a campaign that produced no waste.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · WASTE LOSS',
      subtitle: groupSpan(g),
      tone: 'waste',
      symbols: 'Waste Loss = Σ member waste ÷ produced kg of the campaigns that filed waste',
      inputs: [
        ...wasteInputs(g.waste),
        { label: 'Waste total', value: `${kg(g.wasteKg)} kg` },
        {
          label: 'Produced kg used as the denominator',
          value: `${kg(g.producedKgWasteReported)} kg`,
          note: 'the produced kilos of the campaigns that actually filed waste',
        },
        { label: 'Produced (whole group)', value: `${kg(g.producedKg)} kg` },
        {
          label: 'Campaigns that filed any waste',
          value: `${g.campaignsWasteReported} of ${g.campaignCount}`,
        },
        { label: 'Shifts that filed a waste row', value: `${g.wasteShiftCount} of ${count(g.shiftCount)}` },
      ],
      result: { label: 'Waste loss', value: pctFromFraction(g.wasteLossPct, 2) },
      notes: [
        'THESE EIGHT DO NOT SUM TO THE PROCESS LOSS above — most of it leaves as moisture and volatiles nobody weighs.',
        'The denominator is the produced kilos of the campaigns that FILED WASTE, not the group’s whole produced total: production reporting begins 2025-11-27, and counting a pre-reporting campaign’s kilos against no waste would understate the ratio.',
      ],
    }),
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
      wide: true,
      table: (
        <OpsBlocksTable
          variant="fed"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignBlockCounts(r)}
          totals={fedTotals(r)}
        />
      ),
      result: { label: 'Fed Price', value: phpResult(r.fedPhpKg) },
    }),
    groupDetail: (g, ctx) => ({
      title: 'GROUP · FED PRICE',
      subtitle: groupSpan(g),
      tone: 'money',
      symbols: 'Fed Price = Σ ₱ paid ÷ Σ fed kg',
      inputs: [],
      wide: true,
      table: (
        <OpsBlocksTable
          variant="fed"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupBlockCounts(g)}
          totals={fedTotals(g)}
        />
      ),
      result: { label: 'Fed Price', value: phpResult(g.fedPhpKg) },
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
      wide: true,
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignPriceSetCounts(r)}
          totals={actualTotals(r)}
        />
      ),
      result: { label: 'Actual Fed Price', value: phpResult(r.actualFedPhpKg) },
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
      wide: true,
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupPriceSetCounts(g)}
          totals={groupActualTotals(g)}
        />
      ),
      result: { label: 'Actual Fed Price', value: phpResult(g.actualFedPhpKg) },
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
      wide: true,
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignPriceSetCounts(r)}
          totals={actualTotals(r)}
        />
      ),
      result: { label: 'Resiko Cost', value: phpResult(r.upliftPhpKg) },
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
      wide: true,
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupPriceSetCounts(g)}
          totals={groupActualTotals(g)}
        />
      ),
      result: { label: 'Resiko Cost', value: phpResult(g.upliftPhpKg) },
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
      wide: true,
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.blocks.get(r.campaignKey) ?? []}
          canViewPrices={ctx.canViewPrices}
          counts={campaignPriceSetCounts(r)}
          totals={
            ctx.canViewPrices
              ? actualTotals(r)
              : [
                  { label: 'Resiko loss', value: pctFromFraction(r.blockResikoLossPct, 2) },
                  { label: 'Resiko weight', value: `${kg(r.blockResikoKg)} kg` },
                ]
          }
        />
      ),
      result: { label: 'Resiko Loss', value: pctFromFraction(r.blockResikoLossPct, 2) },
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
      wide: true,
      table: (
        <OpsBlocksTable
          variant="actual"
          rows={ctx.groupBlocks}
          canViewPrices={ctx.canViewPrices}
          counts={groupPriceSetCounts(g)}
          totals={
            ctx.canViewPrices
              ? groupActualTotals(g)
              : [{ label: 'Resiko loss', value: pctFromFraction(g.blockResikoLossPct, 2) }]
          }
        />
      ),
      result: { label: 'Resiko Loss', value: pctFromFraction(g.blockResikoLossPct, 2) },
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
      result: { label: 'PC Cost', value: phpResult(r.phpPerProducedKgDelivered) },
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
      result: { label: 'PC Cost', value: phpResult(g.phpPerProducedKgDelivered) },
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
      result: { label: 'True PC Cost', value: phpResult(r.phpPerProducedKgTrue) },
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
      result: { label: 'True PC Cost', value: phpResult(g.phpPerProducedKgTrue) },
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
      canViewPrices,
    }),
    [campaigns, group, canViewPrices],
  );
  const [detail, setDetail] = React.useState<KpiDetail | null>(null);
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
                details={cols.map((c) => c.campaignDetail(r, ctx))}
                cols={cols}
                onOpen={setDetail}
              />
            ))}
            {showGroup ? (
              <Row
                lead
                title="GROUP"
                subtitle={`${group.campaignCount} campaigns`}
                cells={cols.map((c) => c.group(group))}
                details={cols.map((c) => c.groupDetail(group, ctx))}
                cols={cols}
                onOpen={setDetail}
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

      <OpsKpiModal detail={detail} onClose={() => setDetail(null)} />
    </section>
  );
}

function Row({
  title,
  subtitle,
  cells,
  details,
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
  details: KpiDetail[];
  cols: KpiColumn[];
  lead?: boolean;
  onOpen(detail: KpiDetail): void;
}) {
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
      {cells.map((cell, i) => (
        <td key={cols[i].key} className="border-r border-border/60 p-0 align-middle">
          {/* EVERY CELL IS A BUTTON — full-cell hit area, real button semantics and a
              visible focus ring, so the math is reachable from the keyboard. */}
          <button
            type="button"
            aria-haspopup="dialog"
            title={`${title} · ${cols[i].label} — show the math`}
            onClick={() => onOpen(details[i])}
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
                cell.absent ? 'text-muted-foreground' : cn('font-medium', TONE[cols[i].tone].text),
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
      ))}
    </tr>
  );
}
