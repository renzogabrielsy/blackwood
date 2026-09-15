'use client';

import * as React from 'react';

import { cn } from '@/lib/utils';
import {
  WASTE_STREAMS,
  type OpsCampaignRollup,
  type OpsGroupRollup,
} from '@/lib/operations/types';
import { TONE, type OpsTone } from './ops-color';
import { count, hours, kg, php, pctFromFraction, pctFromPercent, tons } from './ops-format';
import { OpsKpiModal, type KpiDetail, type KpiInput } from './ops-kpi-modal';

// ═════════════════════════════════════════════════════════════════════════════════
// THE EOQ ROLLUP — Renzo's `EOQ3 2026` tab, as a table. ONE ROW PER CAMPAIGN, plus
// the GROUP row when more than one is picked.
//
// ── NINE COLUMNS, IN HIS ORDER, AND NOTHING ELSE (2026-09-15) ───────────────────
//   RC Fed · Produced · Yield · Loss (%) · Waste Loss · Fed Price ·
//   Actual Fed Price · PC Cost · True PC Cost
//
// **THE SUB-CAPTIONS ARE GONE.** Every cell used to carry a small line under it —
// *"24 feed days"*, *"100.0% priced"*, *"whole-block 48.26"*, *"delivered basis"*,
// *"carries the shrinkage"*. Renzo: *"too wordy."* He is right, and the fix is not to
// delete the information: **every cell is now a BUTTON and opens the math** — the
// definition in words and in symbols, each input with its published value, the
// result, and the coverage. What used to be nine cramped captions is one modal per
// figure, which can afford to be complete.
//
// Two cells still carry a second line, because the second line IS the figure:
// WASTE LOSS is kg AND a percent of fed, and ACTUAL FED PRICE carries the RESIKO
// COST (`upliftPhpKg`) and the RESIKO LOSS (`blockResikoLossPct`) it is made of.
//
// ── THREE THINGS THIS COMPONENT MUST NOT DO, AND DOES NOT ───────────────────────
//
//  1. **It computes nothing** — here or in the modal builders. Every cell, and every
//     line of every `KpiDetail`, is a FIELD of the rollup the group RPC or the
//     campaign KPI view produced. `a ÷ b = c` in a modal is three separate published
//     fields printed side by side, never a division. The GROUP row is `data.group` —
//     never a fold of the campaign rows — because every ₱/kg and every ratio in it
//     is WEIGHTED in SQL and the mean of three yields belongs to no quarter.
//  2. **It never prints a ₱ it was not given.** `canViewPrices` drops the four ₱
//     columns from the coordinate space (the RC Movement precedent); the server has
//     already nulled the fields, so this is the render guard, not the gate.
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

/** A rendered cell: the headline, and the extra line(s) that ARE part of the figure. */
interface Cell {
  value: string;
  extra?: string[];
  /** Muted — the value is legitimately absent, never "no data". */
  absent?: boolean;
}

interface KpiColumn {
  key: string;
  label: string;
  unit?: string;
  width: number;
  tone: OpsTone;
  /** Dropped from the layout entirely when the viewer may not see prices. */
  price?: boolean;
  campaign(r: OpsCampaignRollup): Cell;
  group(g: OpsGroupRollup): Cell;
  campaignDetail(r: OpsCampaignRollup): KpiDetail;
  groupDetail(g: OpsGroupRollup): KpiDetail;
}

const DASH: Cell = { value: '—', absent: true };

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
    unit: 't',
    width: 100,
    tone: 'fed',
    campaign: (r) => ({ value: tons(r.fedKg) }),
    group: (g) => ({ value: tons(g.fedKg) }),
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
    unit: 't',
    width: 100,
    tone: 'produced',
    campaign: (r) => (r.productionReported ? { value: tons(r.producedKg) } : DASH),
    group: (g) => ({ value: tons(g.producedKg) }),
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
    campaign: (r) => ({ value: pctFromFraction(r.yieldPct, 2) }),
    group: (g) => ({ value: pctFromFraction(g.yieldPct, 2) }),
    campaignDetail: (r) => ({
      title: `${r.label} · YIELD`,
      subtitle: campaignSpan(r),
      tone: 'yield',
      words:
        'How much finished charcoal came out of the retort for every kilogram fed into it, over the whole campaign. At CAMPAIGN grain the two figures describe the same charcoal; at DAY grain they do not, which is why the ledger’s day column is called DRIFT.',
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
    unit: '%',
    width: 86,
    tone: 'drift',
    campaign: (r) => ({ value: pctFromFraction(r.processLossPct, 2) }),
    group: (g) => ({ value: pctFromFraction(g.processLossPct, 2) }),
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
    unit: 'kg + %',
    width: 118,
    tone: 'waste',
    campaign: (r) => ({
      value: kg(r.wasteKg) || '—',
      absent: r.wasteKg === null,
      extra: [pctFromFraction(r.wasteLossPct, 2)],
    }),
    group: (g) => ({
      value: kg(g.wasteKg) || '—',
      absent: g.wasteKg === null,
      extra: [pctFromFraction(g.wasteLossPct, 2)],
    }),
    campaignDetail: (r) => ({
      title: `${r.label} · WASTE LOSS`,
      subtitle: campaignSpan(r),
      tone: 'waste',
      words:
        'The eight waste streams the plant actually sweeps up and puts on a scale, totalled for the campaign, and what fraction of the charcoal fed they amount to.',
      symbols: 'Waste Loss = (TRML 1 + TRML 2 + RS1A + RS1B + RS2/3 + RS5 + BF + GRITS) ÷ RC Fed',
      inputs: [
        ...wasteInputs(r.waste),
        { label: 'Waste total', value: `${kg(r.wasteKg)} kg` },
        { label: 'RC Fed', value: `${kg(r.fedKg)} kg` },
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
      words:
        'A plain SUM of the member campaigns’ waste. Unlike a block, a SHIFT belongs to exactly one campaign, so waste partitions cleanly and the kilograms simply add — which is why a group waste KG exists where a group resiko KG deliberately does not.',
      symbols: 'Waste Loss = Σ member waste ÷ fed kg of the campaigns that filed waste',
      inputs: [
        ...wasteInputs(g.waste),
        { label: 'Waste total', value: `${kg(g.wasteKg)} kg` },
        {
          label: 'Fed kg used as the denominator',
          value: `${kg(g.fedKgWasteReported)} kg`,
          note: 'the fed kilos of the campaigns that actually filed waste',
        },
        { label: 'Fed (whole group)', value: `${kg(g.fedKg)} kg` },
        {
          label: 'Campaigns that filed any waste',
          value: `${g.campaignsWasteReported} of ${g.campaignCount}`,
        },
        { label: 'Shifts that filed a waste row', value: `${g.wasteShiftCount} of ${count(g.shiftCount)}` },
      ],
      result: { label: 'Waste loss', value: pctFromFraction(g.wasteLossPct, 2) },
      notes: [
        'THESE EIGHT DO NOT SUM TO THE PROCESS LOSS above — most of it leaves as moisture and volatiles nobody weighs.',
        'The denominator is the fed kilos of the campaigns that filed waste, not the group’s whole fed total: production reporting begins 2025-11-27, and counting a pre-reporting campaign’s kilos against no waste would understate the ratio.',
      ],
    }),
  },

  // ── FED PRICE ─────────────────────────────────────────────────────────────────
  {
    key: 'fedprice',
    label: 'Fed Price',
    unit: '₱/kg',
    width: 104,
    tone: 'money',
    price: true,
    campaign: (r) => ({ value: php(r.fedPhpKg) }),
    group: (g) => ({ value: php(g.fedPhpKg) }),
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
  {
    key: 'actual',
    label: 'Actual Fed Price',
    unit: '₱/kg',
    width: 138,
    tone: 'money',
    price: true,
    campaign: (r) => ({
      value: php(r.actualFedPhpKg) || '—',
      absent: r.actualFedPhpKg === null,
      extra: [
        phpLine('resiko cost', r.upliftPhpKg),
        `resiko loss ${pctFromFraction(r.blockResikoLossPct, 2)}`,
      ],
    }),
    group: (g) => ({
      value: php(g.actualFedPhpKg) || '—',
      absent: g.actualFedPhpKg === null,
      extra: [
        phpLine('resiko cost', g.upliftPhpKg),
        `resiko loss ${pctFromFraction(g.blockResikoLossPct, 2)}`,
      ],
    }),
    campaignDetail: (r) => ({
      title: `${r.label} · ACTUAL FED PRICE`,
      subtitle: campaignSpan(r),
      tone: 'money',
      words:
        'What every kilogram that actually reached the plant really cost. A block receives charcoal at a delivered price and then dries out and loses weight — but the money already spent does not shrink, so the surviving kilos each carry more of it. The difference is the RESIKO COST, and the weight that evaporated is the RESIKO LOSS.',
      symbols: 'Actual = whole-block ₱ ÷ whole-block fed kg ·  Resiko cost = Actual − Delivered',
      inputs: [
        { label: 'Delivered (Fed Price)', value: phpLine('', r.fedPhpKg) },
        { label: 'Actual, whole block', value: phpLine('', r.actualFedPhpKg) },
        {
          label: 'Actual, attributed to this campaign',
          value: phpLine('', r.campaignWeightedActualFedPhpKg),
          note: 'weighted by this campaign’s own fed kilos — shape-comparable with Fed Price',
        },
        { label: 'Resiko cost (uplift)', value: phpLine('', r.upliftPhpKg) },
        { label: 'Resiko loss', value: pctFromFraction(r.blockResikoLossPct, 2) },
        { label: 'Resiko weight', value: `${kg(r.blockResikoKg)} kg` },
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
        'The CAMPAIGN-ATTRIBUTED form, weighted in SQL. There is no whole-block group figure and no group resiko KG: a block can be fed by more than one campaign, so summing per-campaign block figures would charge one pile’s whole-life shrinkage twice.',
      symbols: 'Actual = Σ (campaign-attributed ₱) ÷ Σ fed kg ·  Resiko cost = Actual − Delivered',
      inputs: [
        { label: 'Delivered (Fed Price)', value: phpLine('', g.fedPhpKg) },
        { label: 'Actual, campaign-attributed', value: phpLine('', g.actualFedPhpKg) },
        { label: 'Resiko cost (uplift)', value: phpLine('', g.upliftPhpKg) },
        {
          label: 'Resiko loss',
          value: pctFromFraction(g.blockResikoLossPct, 2),
          note: 'a weighted RATIO only — there is no group resiko kg',
        },
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

  // ── PC COST ───────────────────────────────────────────────────────────────────
  {
    key: 'pccost',
    label: 'PC Cost',
    unit: '₱/kg',
    width: 104,
    tone: 'money',
    price: true,
    campaign: (r) => ({ value: php(r.phpPerProducedKgDelivered) }),
    group: (g) => ({ value: php(g.phpPerProducedKgDelivered) }),
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
    unit: '₱/kg',
    width: 118,
    tone: 'money',
    price: true,
    campaign: (r) =>
      r.phpPerProducedKgTrue === null ? DASH : { value: php(r.phpPerProducedKgTrue) },
    group: (g) => (g.phpPerProducedKgTrue === null ? DASH : { value: php(g.phpPerProducedKgTrue) }),
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

const W_LABEL = 176;

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
                  <span className="block truncate">{c.label}</span>
                  {c.unit ? (
                    <span className="block truncate text-[9px] font-normal normal-case opacity-70">
                      {c.unit}
                    </span>
                  ) : null}
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
      className={cn(
        'border-b border-border/60 transition-all duration-150 last:border-b-0 hover:bg-muted/30',
        lead && 'bg-muted/40',
      )}
    >
      <td className="border-r border-border px-2 py-1.5 align-middle">
        <span className={cn('block truncate text-xs', lead ? 'font-semibold' : 'font-medium')}>
          {title}
        </span>
        <span className="block truncate font-mono text-[10px] tabular-nums text-muted-foreground">
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
              'block w-full px-2 py-1.5 text-right transition-colors duration-150',
              'hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring',
            )}
          >
            <span
              className={cn(
                'block truncate font-mono text-sm tabular-nums',
                cell.absent ? 'text-muted-foreground' : cn('font-medium', TONE[cols[i].tone].text),
                lead && !cell.absent && 'font-semibold',
              )}
            >
              {cell.value || '—'}
            </span>
            {cell.extra?.map((line, j) => (
              <span
                key={j}
                className="block truncate font-mono text-[10px] tabular-nums text-muted-foreground"
              >
                {line}
              </span>
            ))}
          </button>
        </td>
      ))}
    </tr>
  );
}
