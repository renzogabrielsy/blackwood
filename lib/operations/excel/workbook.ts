// ═════════════════════════════════════════════════════════════════════════════════
// workbook.ts — THE OPERATIONS EXCEL EXPORT. One click, one file, ready to email.
//
// Renzo: *"The idea is like printing but more Excel-report based for easy emails…
// the Excel should utilize formulas… EOQ Summary should be using formulas to grab
// data from the other month tabs… an RC Movement tab that features 3 separate RC
// Movement tables inside ONE tab."*
//
// ── THE GOVERNING RULE: VALUES IN, FORMULAS OUT ───────────────────────────────
// The platform rule "never compute in TypeScript" (CLAUDE.md) stays intact. This
// module writes exactly two kinds of cell:
//   · INPUT  — a plain value, taken VERBATIM from the payload, which is SQL's own
//              output: the day's fed ₱/kg, grade kg, eight waste streams, shifts,
//              downtime; the block's arrival kg, resiko kg and two prices; the
//              day × block fed kg.
//   · DERIVED — an Excel FORMULA, so the workbook recalculates when Renzo edits an
//              input, and so every total is visibly the sum of the rows above it.
// Nothing is aggregated here. The one exception is documented at its call site
// (`weightedOverPriceSet` in `month-sheet.ts`), and it is a CACHE of a formula this
// module wrote, not a figure the app publishes.
//
// ── EVERY FORMULA CARRIES A CACHED RESULT ─────────────────────────────────────
// …taken from the payload — the database's own published figure — so the file reads
// correctly in a viewer that never recalculates (an email preview, a phone
// quick-look, a Google Sheets import). Excel recalculates on open
// (`fullCalcOnLoad`). The consequence for the `Checks` tab is stated in its header.
//
// ── PRICE GATING IS A SECURITY BOUNDARY ───────────────────────────────────────
// `canViewPrices` comes from the ONE canonical gate (`lib/auth.canViewPrices`, via
// the adapter). For a denied caller the ₱ columns are **STRUCTURALLY ABSENT** — not
// blanked, not hidden (a hidden column is one click from visible), not zeroed. The
// Production workbook is a SMALLER file, not a censored one. The adapter has
// already nulled the ₱ fields server-side; this is the second, structural lock.
//
// ── WHY IT IS BUILT FROM THE OPS-LEDGER PAYLOAD ALONE ─────────────────────────
// The RC Movement tab could in principle come from `fetchRcMovementMatrix()`, but
// its rows are the FED-ONLY span, and every month-tab day — rest days included —
// links to `'RC Movement'!<total>` for its own date. A fed-only matrix has no row
// for a rest day, so half the links would dangle. `view_ops_ledger_day_block` IS
// `view_rc_movement_campaign_cells` re-keyed (CLAUDE.md → Plant Operations Ledger),
// so the ops payload carries the identical kilograms over the full span: one fetch,
// one definition, and no way for the two tabs to describe different populations.
// ═════════════════════════════════════════════════════════════════════════════════

import ExcelJS from 'exceljs';

import { MAX_SHEET_NAME, assertSheetName } from './a1';
import { writeMonthSheet, type MonthSheetLayout } from './month-sheet';
import {
  RC_SHEET_NAME,
  cellKey,
  writeRcMovementFooters,
  writeRcMovementSheet,
} from './rc-movement-sheet';
import { CHECKS_SHEET_NAME, writeChecksSheet } from './checks-sheet';
import { EOQ_SHEET_NAME, writeEoqSheet } from './eoq-sheet';
import type {
  OpsCampaignBlock,
  OpsCampaignRollup,
  OpsGroupRollup,
  OpsLedgerData,
  OpsLedgerDay,
} from '../types';

/** One campaign, reshaped into exactly what the sheet builders read. */
export interface OpsExcelCampaign {
  key: string;
  /** The worksheet name — `JULY 2026`. Unique and ≤ 31 chars. */
  sheetName: string;
  label: string;
  /** Every calendar day of the campaign's span, rest days included, in date order. */
  days: OpsLedgerDay[];
  /** The blocks this campaign drew from — the BLOCKS USED rows AND the matrix columns. */
  blocks: OpsCampaignBlock[];
  rollup: OpsCampaignRollup;
  /** `${date}|${batchId}` → kg fed. */
  cells: Map<string, number | null>;
  /** grade → the campaign's own kg, for the totals row's cached value. */
  gradeTotals: Record<string, number | null>;
}

/** The whole workbook's input. Nothing here touches Supabase. */
export interface OpsExcelInput {
  /** `Q3 2026`, or the campaign labels joined — whatever the page is showing. */
  groupLabel: string;
  campaigns: OpsExcelCampaign[];
  group: OpsGroupRollup | null;
  /** Every grade any campaign produced, in display order — one column set for all tabs. */
  grades: string[];
  canViewPrices: boolean;
  /** Asia/Manila calendar date the payload was read — the Checks tab's as-of. */
  asOf: string;
}

export interface OpsExcelResult {
  buffer: Buffer;
  /** `Blackwood Operations — Q3 2026.xlsx`. Carries an em dash: send it RFC 5987. */
  filename: string;
  sheetNames: string[];
  containsPrices: boolean;
}

/** Asia/Manila calendar date, `yyyy-MM-dd`. The plant's own clock, never UTC. */
export function manilaDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * `Blackwood Operations — Q3 2026.xlsx`.
 *
 * The EM DASH is deliberate (it is the page's own typography) and is precisely why
 * the route must send an RFC 5987 `filename*` — a bare `filename=` is Latin-1 only.
 */
export function opsExcelFilename(groupLabel: string): string {
  const safe = groupLabel.replace(/[\\/:*?"<>|]/g, '-').trim() || 'export';
  return `Blackwood Operations — ${safe}.xlsx`;
}

/**
 * RESHAPE — the adapter's payload into the builder's input. A grouping, never a
 * computation: no figure is summed, averaged or weighted on the way through.
 */
export function toExcelInput(
  data: OpsLedgerData,
  groupLabel: string,
  asOf: string = manilaDate(),
): OpsExcelInput {
  const daysByCampaign = new Map<string, OpsLedgerDay[]>();
  for (const day of data.days) {
    const list = daysByCampaign.get(day.campaignKey);
    if (list) list.push(day);
    else daysByCampaign.set(day.campaignKey, [day]);
  }

  const used = new Set<string>();
  const campaigns: OpsExcelCampaign[] = [];

  for (const campaign of data.campaigns) {
    const rollup = data.rollups.find((r) => r.campaignKey === campaign.key);
    if (!rollup) continue; // a campaign with no rollup row has no tab to draw
    const days = daysByCampaign.get(campaign.key) ?? [];
    const blocks = campaign.blocks;
    const known = new Set(blocks.map((b) => b.batchId));

    const cells = new Map<string, number | null>();
    for (const day of days) {
      for (const feed of day.blocksFed) {
        if (!known.has(feed.batchId)) {
          // LOUD, never silent. The two views are the same relation re-keyed, so a
          // block fed on a day but absent from the campaign's block list would mean
          // the payload disagrees with itself — and a dropped cell would quietly
          // lose kilograms out of a column total and out of the FED WT link.
          throw new Error(
            `ops excel: ${campaign.key} fed block ${feed.batchCode} on ${day.date}, but that block is not in the campaign's block list`,
          );
        }
        cells.set(cellKey(day.date, feed.batchId), feed.fedKg);
      }
    }

    const gradeTotals: Record<string, number | null> = {};
    for (const g of data.gradesByCampaign[campaign.key] ?? []) gradeTotals[g.grade] = g.kg;

    campaigns.push({
      key: campaign.key,
      sheetName: uniqueSheetName(campaign.label, used),
      label: campaign.label,
      days,
      blocks,
      rollup,
      cells,
      gradeTotals,
    });
  }

  return {
    groupLabel,
    campaigns,
    group: data.group,
    grades: data.grades,
    canViewPrices: data.canViewPrices,
    asOf,
  };
}

/** Builds the workbook in memory and hands back its bytes. Pure — no I/O. */
export async function buildOpsWorkbook(input: OpsExcelInput): Promise<OpsExcelResult> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Blackwood';
  wb.created = new Date();
  // Excel recomputes every formula on open, so the cached results below are only
  // ever the FIRST thing a reader sees, never what the workbook means.
  wb.calcProperties.fullCalcOnLoad = true;

  // SHEETS ARE CREATED IN DISPLAY ORDER AND WRITTEN IN DEPENDENCY ORDER — the two
  // are not the same. EOQ comes first in the tab strip and is filled last, because
  // every one of its cells points at a month tab that has to exist.
  const wsEoq = wb.addWorksheet(EOQ_SHEET_NAME);
  const monthSheets = input.campaigns.map((c) => ({
    campaign: c,
    ws: wb.addWorksheet(c.sheetName),
  }));
  const wsRc = wb.addWorksheet(RC_SHEET_NAME);
  const wsChecks = wb.addWorksheet(CHECKS_SHEET_NAME);

  // 1 · the matrices (their coordinates are what the month tabs link to)
  const rcTables = writeRcMovementSheet(wsRc, input);
  const rcByCampaign = new Map(rcTables.map((t) => [t.campaignKey, t]));

  // 2 · the month tabs
  const months = new Map<string, MonthSheetLayout>();
  for (const { campaign, ws } of monthSheets) {
    const rc = rcByCampaign.get(campaign.key);
    if (!rc) continue;
    months.set(campaign.key, writeMonthSheet(ws, input, campaign, rc));
  }

  // 3 · the RC Movement footer rows, which link INTO the month tabs
  writeRcMovementFooters(wsRc, input, rcTables, months);

  // 4 · the self-audit, then the summary that reports it
  const checks = writeChecksSheet(wsChecks, input, months, input.asOf);
  writeEoqSheet(wsEoq, input, months, checks);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return {
    buffer,
    filename: opsExcelFilename(input.groupLabel),
    sheetNames: wb.worksheets.map((w) => w.name),
    containsPrices: input.canViewPrices,
  };
}

/**
 * A worksheet name Excel will accept, unique within the workbook.
 *
 * `JULY 2026` needs none of this — but a campaign is named by whatever
 * `production_batch` says, and a 40-character batch name would make
 * `wb.addWorksheet` throw halfway through a download.
 */
function uniqueSheetName(label: string, used: Set<string>): string {
  const cleaned = label.replace(/[[\]:*?/\\]/g, '-').replace(/^'+|'+$/g, '').trim() || 'CAMPAIGN';
  let name = cleaned.slice(0, MAX_SHEET_NAME);
  for (let n = 2; used.has(name.toLowerCase()); n += 1) {
    const suffix = ` (${n})`;
    name = `${cleaned.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`;
  }
  assertSheetName(name);
  used.add(name.toLowerCase());
  return name;
}
