'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  WASTE_STREAMS,
  type OpsCampaignRollup,
  type OpsGroupRollup,
} from '@/lib/operations/types';
import { UnitValue } from '@/components/shared/unit-value';
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

interface KpiColumn {
  key: string;
  label: string;
  width: number;
  tone: OpsTone;
  /** Dropped from the layout entirely when the viewer may not see prices. */
  price?: boolean;
  campaign(r: OpsCampaignRollup): Cell;
  group(g: OpsGroupRollup): Cell;
  campaignDetail(r: OpsCampaignRollup): KpiDetail;
  groupDetail(g: OpsGroupRollup): KpiDetail;
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
      words:
        'The kilograms of raw charcoal the plant was actually fed over the campaign. FED means destination = MAIN only: a pull out to sun-dry left the block but never reached the plant, so it is reported beside this figure and never inside it.',
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
      words:
        'Kilograms SUM across the campaigns in the group — a shift and a feeding each belong to exactly one campaign, so there is nothing to double-count. Only the BLOCK counts are de-duplicated, because one block can be fed by more than one campaign.',
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
      words:
        'Finished charcoal filed against this production batch. A production day is a day with a production_runs child — the digest’s own rule, carried across so the two screens count the same days.',
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
      words:
        'The member campaigns’ produced kilograms, summed. A changeover date counts in BOTH campaigns as a campaign-day, which is why the campaign-day count can exceed the calendar-day count.',
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
      words:
        'How much finished charcoal came out of the retort for every kilogram fed into it, over the whole campaign. At CAMPAIGN grain the two figures describe the same charcoal; at DAY grain they do not — the feed tank is continuous flow — which is why the ledger’s own YIELD % column is labelled indicative and this one is not.',
      symbols: 'Yield = Produced ÷ RC Fed',
      inputs: [
        { label: 'Produced', value: `${kg(r.producedKg)} kg` },
        { label: 'RC Fed', value: `${kg(r.fedKg)} kg` },
      ],
      result: { label: 'Yield', value: pctFromFraction(r.yieldPct, 2) },
      notes: [
        'The database publishes this as a FRACTION and the screen multiplies by 100 to print it — the same convention /analytics uses, kept so the two screens compare digit for digit.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · YIELD',
      subtitle: groupSpan(g),
      tone: 'yield',
      words:
        'Weighted in SQL, never the mean of the member yields. The denominator is the fed kilograms of the campaigns that actually REPORTED production — production reporting began 2025-11-27, so a group straddling that boundary would be understated if the unreported campaigns’ kilos were counted against nothing.',
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
      words:
        'The retort’s own loss — everything fed that did not come out as product. Most of it leaves as moisture and volatiles that nobody weighs, which is why the WASTE LOSS beside it (the eight streams that WERE weighed) is much smaller and never adds up to this.',
      symbols: 'Loss = 1 − Yield ·  Loss kg = RC Fed − Produced',
      inputs: [
        { label: 'RC Fed', value: `${kg(r.fedKg)} kg` },
        { label: 'Produced', value: `${kg(r.producedKg)} kg` },
        { label: 'Process loss', value: `${kg(r.processLossKg)} kg` },
        { label: 'Yield', value: pctFromFraction(r.yieldPct, 2) },
      ],
      result: { label: 'Process loss', value: pctFromFraction(r.processLossPct, 2) },
      notes: [
        'This is the RETORT’s loss. The yard’s own shrinkage — evaporation in the pile between arrival and feeding — is a separate figure and rides under ACTUAL FED PRICE as the resiko loss.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · PROCESS LOSS',
      subtitle: groupSpan(g),
      tone: 'drift',
      words:
        'The member campaigns’ loss kilograms summed, and the ratio weighted in SQL over the campaigns that reported production.',
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
      words:
        'The eight waste streams the plant actually sweeps up and puts on a scale, totalled for the campaign, and what fraction of the charcoal PRODUCED they amount to.',
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
        'The denominator is PRODUCTION OUTPUT, not charcoal fed: what gets swept up came OUT of the retort and was then rejected, so dividing it by what went in would mix it with the moisture the Process Loss figure already covers.',
        'NULL IS NEVER 0 — a campaign none of whose shifts filed a waste row reads blank on every stream, which is not the same as a campaign that produced no waste.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · WASTE LOSS',
      subtitle: groupSpan(g),
      tone: 'waste',
      words:
        'A plain SUM of the member campaigns’ waste. Unlike a block, a SHIFT belongs to exactly one campaign, so waste partitions cleanly and the kilograms simply add — which is why a group waste KG exists where a group resiko KG deliberately does not.',
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
        'The denominator is PRODUCTION OUTPUT, not charcoal fed: what gets swept up came OUT of the retort and was then rejected.',
        'It is the produced kilos of the campaigns that filed waste, not the group’s whole produced total: production reporting begins 2025-11-27, and counting a pre-reporting campaign’s kilos against no waste would understate the ratio.',
      ],
    }),
  },

  // ── FED PRICE ─────────────────────────────────────────────────────────────────
  {
    key: 'fedprice',
    label: 'Fed Price',
    width: 108,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.fedPhpKg),
    group: (g) => phpFig(g.fedPhpKg),
    campaignDetail: (r) => ({
      title: `${r.label} · FED PRICE`,
      subtitle: campaignSpan(r),
      tone: 'money',
      words:
        'What the charcoal cost ON ARRIVAL, per kilogram actually fed — the DELIVERED basis. It does not carry the shrinkage the pile suffered while it sat in the yard; the figure that does is ACTUAL FED PRICE beside it.',
      symbols: 'Fed Price = ₱ paid for the charcoal fed ÷ RC Fed',
      inputs: [
        { label: '₱ paid for the charcoal fed', value: php(r.fedValuePhp) },
        { label: 'RC Fed', value: `${kg(r.fedKg)} kg` },
        {
          label: 'Fed kilos with a traceable price',
          value: pctFromPercent(r.fedPriceCoveragePct, 1),
          note: 'a batch with no delivery rows puts kilos in the denominator and nothing in the numerator',
        },
      ],
      result: { label: 'Fed Price', value: phpResult(r.fedPhpKg) },
    }),
    groupDetail: (g) => ({
      title: 'GROUP · FED PRICE',
      subtitle: groupSpan(g),
      tone: 'money',
      words:
        'Weighted by fed kilograms in SQL, never the mean of the member prices — a heavy month and a light month do not count equally.',
      symbols: 'Fed Price = Σ ₱ paid ÷ Σ fed kg',
      inputs: [
        { label: '₱ paid for the charcoal fed', value: php(g.fedValuePhp) },
        { label: 'RC Fed', value: `${kg(g.fedKg)} kg` },
        { label: 'Fed kilos with a traceable price', value: pctFromPercent(g.fedPriceCoveragePct, 1) },
      ],
      result: { label: 'Fed Price', value: phpResult(g.fedPhpKg) },
    }),
  },

  // ── ACTUAL FED PRICE ──────────────────────────────────────────────────────────
  // The price itself. Its two components — the RESIKO COST it is made of and the
  // RESIKO LOSS that caused it — are the two columns after it, each with its own
  // modal, so this cell is one line like every other.
  {
    key: 'actual',
    label: 'Actual Fed Price',
    width: 118,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.actualFedPhpKg),
    group: (g) => phpFig(g.actualFedPhpKg),
    campaignDetail: (r) => ({
      title: `${r.label} · ACTUAL FED PRICE`,
      subtitle: campaignSpan(r),
      tone: 'money',
      words:
        'What every kilogram that actually reached the plant really cost. A block receives charcoal at a delivered price and then dries out and loses weight — but the money already spent does not shrink, so the surviving kilos each carry more of it. How much more is the RESIKO COST column; how much weight went is the RESIKO LOSS column.',
      symbols: 'Actual Fed Price = whole-block ₱ ÷ whole-block fed kg',
      inputs: [
        { label: 'Delivered (Fed Price)', value: phpLine('', r.fedPhpKg) },
        { label: 'Actual, whole block', value: phpLine('', r.actualFedPhpKg) },
        {
          label: 'Actual, attributed to this campaign',
          value: phpLine('', r.campaignWeightedActualFedPhpKg),
          note: 'weighted by this campaign’s own fed kilos — shape-comparable with Fed Price',
        },
        { label: 'Blocks closed', value: `${count(r.blocksClosed)} of ${count(r.blocksFed)}` },
        { label: 'Blocks fully priced', value: count(r.blocksInPrice) },
        { label: 'Blocks still open', value: count(r.blocksOpen) },
        {
          label: 'Campaign fed kg inside the price set',
          value: `${kg(r.campaignFedKgIncluded)} kg`,
          note: pctFromFraction(r.campaignFedKgIncludedPct, 1),
        },
      ],
      result: { label: 'Actual Fed Price', value: phpResult(r.actualFedPhpKg) },
      notes: [
        'It exists only for blocks that are CLOSED and fully priced — until a block is closed its fed total is not final, and an unpriced delivery would put kilos in the denominator with no money against them and push the figure the wrong way.',
        'A block with any sun-drying outflow is excluded rather than guessed at: its money physically left with the charcoal and comes back inside a different batch.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · ACTUAL FED PRICE',
      subtitle: groupSpan(g),
      tone: 'money',
      words:
        'The CAMPAIGN-ATTRIBUTED form, weighted in SQL. There is no whole-block group figure: a block can be fed by more than one campaign, so summing per-campaign block figures would charge one pile’s whole-life shrinkage twice.',
      symbols: 'Actual Fed Price = Σ (campaign-attributed ₱) ÷ Σ fed kg',
      inputs: [
        { label: 'Delivered (Fed Price)', value: phpLine('', g.fedPhpKg) },
        { label: 'Actual, campaign-attributed', value: phpLine('', g.actualFedPhpKg) },
        {
          label: 'Campaigns fully covered',
          value: `${g.campaignsFullyCovered} of ${g.campaignCount}`,
        },
        { label: 'Distinct blocks closed', value: String(g.blocksClosedDistinct) },
        { label: 'Distinct blocks open', value: String(g.blocksOpenDistinct) },
        { label: 'Share of fed kg that is covered', value: pctFromFraction(g.coveredFedKgShare, 1) },
      ],
      result: { label: 'Actual Fed Price', value: phpResult(g.actualFedPhpKg) },
    }),
  },

  // ── RESIKO COST ───────────────────────────────────────────────────────────────
  // `upliftPhpKg` — actual minus delivered, per kilogram fed. A ₱ column, so it goes
  // when the viewer may not see prices.
  {
    key: 'resikocost',
    label: 'Resiko Cost',
    width: 112,
    tone: 'money',
    price: true,
    campaign: (r) => phpFig(r.upliftPhpKg),
    group: (g) => phpFig(g.upliftPhpKg),
    campaignDetail: (r) => ({
      title: `${r.label} · RESIKO COST`,
      subtitle: campaignSpan(r),
      tone: 'money',
      words:
        'What the yard’s shrinkage ADDED to every kilogram the plant was fed. The pile lost weight between arrival and feeding, the money already spent did not, so the kilos that survived carry the rest of it. This is the gap between the price on the delivery note and what the charcoal actually cost by the time it reached the retort.',
      symbols: 'Resiko Cost = Actual Fed Price − Fed Price',
      inputs: [
        { label: 'Actual Fed Price', value: phpLine('', r.actualFedPhpKg) },
        { label: 'Fed Price (delivered)', value: phpLine('', r.fedPhpKg) },
        { label: 'Resiko cost (uplift)', value: phpLine('', r.upliftPhpKg) },
        { label: 'Resiko loss', value: pctFromFraction(r.blockResikoLossPct, 2) },
        { label: 'Resiko weight', value: `${kg(r.blockResikoKg)} kg` },
        { label: 'Blocks in the price set', value: `${count(r.blocksInPrice)} of ${count(r.blocksFed)}` },
      ],
      result: { label: 'Resiko Cost', value: phpResult(r.upliftPhpKg) },
      notes: [
        'It is legitimately 0 or NEGATIVE on some blocks — roughly 27% of closed blocks — and is not clamped: a block that gained weight back, or whose paperwork was filed late, is a real reading and hiding it would flatter the figure.',
        'It is blank whenever ACTUAL FED PRICE is, and for the same reasons: a block must be CLOSED and fully priced before its fed total and its money are both final.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · RESIKO COST',
      subtitle: groupSpan(g),
      tone: 'money',
      words:
        'The same difference at group grain, both sides weighted in SQL over the campaign-attributed actual price — never the mean of the member uplifts.',
      symbols: 'Resiko Cost = Actual Fed Price − Fed Price',
      inputs: [
        { label: 'Actual Fed Price (campaign-attributed)', value: phpLine('', g.actualFedPhpKg) },
        { label: 'Fed Price (delivered)', value: phpLine('', g.fedPhpKg) },
        { label: 'Resiko cost (uplift)', value: phpLine('', g.upliftPhpKg) },
        {
          label: 'Campaigns fully covered',
          value: `${g.campaignsFullyCovered} of ${g.campaignCount}`,
        },
        { label: 'Share of fed kg that is covered', value: pctFromFraction(g.coveredFedKgShare, 1) },
      ],
      result: { label: 'Resiko Cost', value: phpResult(g.upliftPhpKg) },
    }),
  },

  // ── RESIKO LOSS ───────────────────────────────────────────────────────────────
  // `blockResikoLossPct` — a WEIGHT ratio. No ₱ in it and none derivable, so it is
  // NOT `price`-flagged and Production keeps it; amber, not violet, says the same.
  {
    key: 'resikoloss',
    label: 'Resiko Loss',
    width: 96,
    tone: 'drift',
    campaign: (r) => pctFig(r.blockResikoLossPct),
    group: (g) => pctFig(g.blockResikoLossPct),
    campaignDetail: (r) => ({
      title: `${r.label} · RESIKO LOSS`,
      subtitle: campaignSpan(r),
      tone: 'drift',
      words:
        'THE YARD’S OWN LOSS, in weight. Charcoal sitting in a block evaporates and shrinks, so less leaves the pile than arrived into it; this is that shortfall as a share of what arrived. It is a different loss from the retort’s — read the LOSS column for that one — and the two are never added together.',
      symbols: 'Resiko Loss = resiko weight ÷ delivered weight, over the blocks in the price set',
      inputs: [
        { label: 'Resiko weight', value: `${kg(r.blockResikoKg)} kg` },
        { label: 'Blocks closed', value: `${count(r.blocksClosed)} of ${count(r.blocksFed)}` },
        { label: 'Blocks fully priced', value: count(r.blocksInPrice) },
        { label: 'Blocks with a sun-drying outflow', value: count(r.blocksWithSundry) },
        {
          label: 'Campaign fed kg inside the price set',
          value: `${kg(r.campaignFedKgIncluded)} kg`,
          note: pctFromFraction(r.campaignFedKgIncludedPct, 1),
        },
        { label: 'Resiko cost it caused', value: phpLine('', r.upliftPhpKg) },
      ],
      result: { label: 'Resiko Loss', value: pctFromFraction(r.blockResikoLossPct, 2) },
      notes: [
        'It is measured over CLOSED blocks only: while a block is still open the charcoal left in the pile is stock, not loss, and counting it as shrinkage would invent evaporation that has not happened.',
        'THIS COLUMN CARRIES NO ₱ and none is derivable from it, so it stays on screen for every role — including Production, which may not see what the shrinkage cost.',
      ],
    }),
    groupDetail: (g) => ({
      title: 'GROUP · RESIKO LOSS',
      subtitle: groupSpan(g),
      tone: 'drift',
      words:
        'The fed-kg-weighted ratio across the member campaigns. THE GROUP PUBLISHES NO RESIKO KILOGRAMS — a block can be fed by more than one campaign (measured: 78 of 523), so adding up per-campaign resiko weights would charge one pile’s whole-life shrinkage once per campaign that touched it. The ratio is weighted instead, which does not double-count.',
      symbols: 'Resiko Loss = weighted over the covered fed kg of the member campaigns',
      inputs: [
        {
          label: 'Resiko loss',
          value: pctFromFraction(g.blockResikoLossPct, 2),
          note: 'a weighted RATIO only — there is no group resiko kg',
        },
        { label: 'Distinct blocks closed', value: String(g.blocksClosedDistinct) },
        { label: 'Distinct blocks open', value: String(g.blocksOpenDistinct) },
        {
          label: 'Naive Σ of per-campaign block counts',
          value: count(g.blocksFedCampaignSum),
          note: 'larger than the distinct count — which is exactly why no kg is published',
        },
        { label: 'Share of fed kg that is covered', value: pctFromFraction(g.coveredFedKgShare, 1) },
        { label: 'Resiko cost it caused', value: phpLine('', g.upliftPhpKg) },
      ],
      result: { label: 'Resiko Loss', value: pctFromFraction(g.blockResikoLossPct, 2) },
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
      words:
        'The raw-charcoal cost of one kilogram of FINISHED product, on the DELIVERED basis. Because only part of what is fed survives the retort, each surviving kilo carries the cost of the kilos that did not: a lower yield makes this figure rise even when the purchase price has not moved.',
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
      words: 'The same definition, with both sides weighted in SQL across the member campaigns.',
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
      words:
        'PC COST carrying the yard’s shrinkage as well as the retort’s — the raw-charcoal cost of a kilogram of finished product measured from the money that was actually spent, not from the price on the delivery note.',
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
      words:
        'The same definition at group grain, weighted in SQL. Strict NULL unless EVERY member campaign is fully covered — but the covered partial is always computed and printed beside it, labelled, so the blank is never the end of the answer.',
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

const W_LABEL = 170;

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
  rollups: readonly OpsCampaignRollup[];
  group: OpsGroupRollup | null;
  canViewPrices: boolean;
  className?: string;
}

export function OpsKpiStrip({ rollups, group, canViewPrices, className }: OpsKpiStripProps) {
  const cols = React.useMemo(
    () => COLUMNS.filter((c) => canViewPrices || !c.price),
    [canViewPrices],
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
                subtitle={`${r.firstDate} → ${r.lastDate}`}
                cells={cols.map((c) => c.campaign(r))}
                details={cols.map((c) => c.campaignDetail(r))}
                cols={cols}
                onOpen={setDetail}
              />
            ))}
            {showGroup ? (
              <Row
                lead
                title="GROUP"
                subtitle={`${group.campaignCount} campaigns · ${group.firstDate} → ${group.lastDate}`}
                cells={cols.map((c) => c.group(group))}
                details={cols.map((c) => c.groupDetail(group))}
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
  subtitle: string;
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
        <span className="block truncate font-mono text-[10px] leading-tight tabular-nums text-muted-foreground">
          {subtitle}
        </span>
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
