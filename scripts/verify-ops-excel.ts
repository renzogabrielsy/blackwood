/**
 * verify-ops-excel.ts — framework-free assertions over the operations Excel export
 * (`lib/operations/excel/**`). No DB, no browser, no React.
 *
 * It BUILDS the Q3 2026 workbook from a fixture derived from the mock-up's own
 * live JSON (`.agents/plans/ops-ledger-excel-mockup/{july,august,september,kpis}.json`),
 * RE-OPENS it with ExcelJS, and checks the things a reader cannot check by eye:
 *
 *   a · every formula reference resolves — the sheet exists, and a cross-tab link
 *       lands on a cell that is actually written. A dangling link in Excel is not
 *       an error, it is a 0.
 *   b · every cached result is the payload's own figure. The cache is what a
 *       non-recalculating viewer shows, so a wrong one is a wrong report.
 *   c · sheet names fit Excel's 31 characters and are quoted wherever referenced.
 *   d · the PRICE-DENIED build contains no ₱ glyph, no price header and no price
 *       column ANYWHERE — values, formulas, number formats and cell comments.
 *   e · the GROUP row publishes no resiko KG (a shared block would be double
 *       counted — the same refusal `fn_ops_ledger_group_kpis` makes in SQL).
 *   f · the layout coordinates of plan §10, Renzo's standing format.
 *
 * Run: npx tsx scripts/verify-ops-excel.ts
 */
import assert from 'node:assert';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';

import { WASTE_STREAMS } from '../lib/operations/types';
import type {
  OpsCampaign,
  OpsCampaignBlock,
  OpsCampaignRollup,
  OpsGroupRollup,
  OpsLedgerData,
  OpsLedgerDay,
  OpsWaste,
} from '../lib/operations/types';
import {
  buildOpsWorkbook,
  opsExcelFilename,
  toExcelInput,
  type OpsExcelInput,
} from '../lib/operations/excel/workbook';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, '.agents', 'plans', 'ops-ledger-excel-mockup');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

// ═══ THE FIXTURE ══════════════════════════════════════════════════════════════
// The mock-up's JSON is positional (it was written for a Python script). Decoding
// it here rather than hand-typing a payload keeps the verification pointed at REAL
// Q3 2026 shapes — 33/29/19 days, 19/16/11 blocks, rest days, open blocks, a
// campaign whose TRUE PC COST is legitimately blank.

type DayRow = [
  string, // date
  string, // weekday
  number | null, // fed ₱/kg
  number | null, // fed kg
  number, // shifts
  number | null, // downtime hours
  ...(number | null)[], // eight waste streams, then the grade map
];
type BlockRow = [
  string, string | null, string | null, string | null, string, boolean,
  number | null, number | null, number | null, number | null,
  number | null, number | null, boolean,
];
type CellRow = [string, string, number | null];
interface CampaignJson {
  days: DayRow[];
  blocks: BlockRow[];
  cells: CellRow[];
}
interface KpiJson {
  key: string;
  fed: number | null;
  prod: number | null;
  yield: number | null;
  loss: number | null;
  waste: number | null;
  waste_pct: number | null;
  fed_price: number | null;
  actual: number | null;
  actual_whole: number | null;
  uplift: number | null;
  resiko_loss: number | null;
  pc: number | null;
  true_pc: number | null;
  fully: boolean;
  incl_kg: number | null;
}

const CAMPAIGNS = [
  { key: 'JULY-2026', label: 'JULY 2026', file: 'july' },
  { key: 'AUGUST-2026', label: 'AUGUST 2026', file: 'august' },
  { key: 'SEPTEMBER-2026', label: 'SEPTEMBER 2026', file: 'september' },
];
const GRADES = ['3X50', '6X50', '8X50', '2X6', '4X8'];

const json = (f: string) => JSON.parse(readFileSync(join(FIXTURES, `${f}.json`), 'utf8'));
const KPIS: Record<string, KpiJson> = Object.fromEntries(
  (json('kpis') as KpiJson[]).map((k) => [k.key, k]),
);

const sumOf = (xs: (number | null)[]): number | null => {
  const live = xs.filter((x): x is number => x !== null && x !== undefined);
  return live.length > 0 ? live.reduce((a, b) => a + b, 0) : null;
};

function decodeCampaign(c: (typeof CAMPAIGNS)[number]) {
  const data = json(c.file) as CampaignJson;
  const blockOf = new Map(data.blocks.map((b, i) => [b[0], `batch-${c.key}-${i}`]));

  const days: OpsLedgerDay[] = data.days.map((d) => {
    const streams = WASTE_STREAMS.map((_, i) => (d[6 + i] as number | null) ?? null);
    const waste = Object.fromEntries(
      WASTE_STREAMS.map((s, i) => [s.key, streams[i]]),
    ) as OpsWaste;
    const grades = (d[14] as unknown as Record<string, number> | null) ?? null;
    const producedKg = grades ? sumOf(Object.values(grades)) : null;
    const totalWasteKg = sumOf(streams);
    const fedKg = d[3] ?? null;
    const blocksFed = data.cells
      .filter((cell) => cell[0] === d[0])
      .map((cell) => ({
        batchId: blockOf.get(cell[1]) ?? cell[1],
        batchCode: cell[1],
        blockLoc: null,
        fedKg: cell[2],
        sundryKg: null,
        mc: null, ash: null, bdAstm: null, bdJis: null, grit: null, vm: null, fc: null,
      }));
    return {
      campaignKey: c.key,
      campaignLabel: c.label,
      date: d[0],
      weekday: d[1],
      isoWeekday: 1,
      isWeekend: false,
      isRestDay: fedKg === null && grades === null && d[4] === 0,
      fedKg,
      sundryKg: null,
      fedPhpKg: d[2] ?? null,
      producedKg,
      dayDriftKg: null,
      blocksFedCount: blocksFed.length,
      shiftCount: d[4],
      shiftHrsTotal: null,
      downtimeHours: d[5] ?? null,
      downtimeIncidentCount: 0,
      downtimeShiftCount: 0,
      downtimeShiftsWithDuration: 0,
      downtimeShiftsReasonOnly: 0,
      runCount: 0,
      sacks: null,
      runsWithSacks: 0,
      waste,
      totalWasteKg,
      productionReported: producedKg !== null,
      wastePct:
        totalWasteKg !== null && producedKg !== null && producedKg > 0
          ? totalWasteKg / producedKg
          : null,
      yieldPct: null,
      lossPct: null,
      producedByGrade: grades ?? {},
      blocksFed,
      fedBlend: null,
      shifts: [],
    } satisfies OpsLedgerDay;
  });

  const blocks: OpsCampaignBlock[] = data.blocks.map((b) => ({
    campaignKey: c.key,
    batchId: blockOf.get(b[0])!,
    batchCode: b[0],
    blockLoc: b[1],
    campaignFedKg: b[6],
    campaignSundryKg: null,
    campaignFeedDays: 0,
    firstCampaignFeedDate: null,
    lastCampaignFeedDate: null,
    firstFedDate: b[2],
    closeDate: b[3],
    isClosed: b[5],
    state: b[4],
    totalFedKg: null,
    totalOutKg: null,
    deliveredKg: b[7],
    weightLostKg: null,
    lossPct: null,
    resikoKg: b[8],
    resikoPct: b[8] !== null && b[7] ? b[8] / b[7] : null,
    balanceKg: b[9],
    hasSundryOutflow: false,
    sundryKg: null,
    hasUnpricedDelivery: false,
    unpricedDeliveryCount: null,
    isFullyPriced: true,
    inPriceSet: b[12],
    feedCount: null,
    deliveryCount: null,
    deliveredPhpKg: b[10],
    pricedDeliveredPhpKg: b[10],
    actualFedPhpKg: b[11],
    upliftPhpKg: b[11] !== null && b[10] !== null ? b[11] - b[10] : null,
  }));

  const k = KPIS[c.label.replace(' ', '-')];
  const rollup = {
    campaignKey: c.key,
    label: c.label,
    productionBatch: c.label.split(' ')[0],
    campaignYear: 2026,
    firstDate: days[0].date,
    lastDate: days[days.length - 1].date,
    spanDays: days.length,
    firstFedDate: null,
    lastFedDate: null,
    feedDays: 0,
    fedKg: k.fed,
    producedKg: k.prod,
    productionReported: true,
    yieldPct: k.yield,
    processLossKg: null,
    processLossPct: k.loss,
    blockResikoKg: null,
    blockResikoLossPct: k.resiko_loss,
    blocksDeliveredKg: sumOf(blocks.map((b) => b.deliveredKg)),
    blocksClosedDeliveredKg: null,
    blocksTotalFedKg: null,
    blocksResikoKg: sumOf(blocks.filter((b) => b.isClosed).map((b) => b.resikoKg)),
    blocksClosedResikoLossPct: k.resiko_loss,
    waste: Object.fromEntries(
      WASTE_STREAMS.map((s) => [s.key, sumOf(days.map((d) => d.waste[s.key]))]),
    ) as OpsWaste,
    wasteKg: k.waste,
    wasteShiftCount: 0,
    wasteLossPct: k.waste_pct,
    fedPhpKg: k.fed_price,
    fedValuePhp: null,
    actualFedPhpKg: k.actual_whole,
    campaignWeightedActualFedPhpKg: k.actual,
    upliftPhpKg: k.uplift,
    phpPerProducedKgDelivered: k.pc,
    phpPerProducedKgTrue: k.true_pc,
    fedPriceCoveragePct: null,
    blocksFed: blocks.length,
    blocksClosed: blocks.filter((b) => b.isClosed).length,
    blocksOpen: blocks.filter((b) => !b.isClosed).length,
    blocksInPrice: blocks.filter((b) => b.inPriceSet).length,
    blocksClosedUnpriced: null,
    blocksWithSundry: null,
    campaignFedKgIncluded: k.incl_kg,
    campaignFedKgIncludedPct: null,
    isFullyCovered: k.fully,
    sundryKg: null,
    outKg: null,
    reportedDays: null,
    shiftCount: sumOf(days.map((d) => d.shiftCount || null)),
    runCount: null,
    downtimeHours: sumOf(days.map((d) => d.downtimeHours)),
    downtimeShiftCount: null,
    downtimeShiftsWithDuration: null,
    downtimeShiftsReasonOnly: null,
    sacks: null,
    runsWithSacks: null,
    sacksCoveragePct: null,
    kwh: null,
    kwhDays: null,
    kwhSuspectReadingCount: null,
    kwhPerProducedKg: null,
    kwhPerProducedKgExclSuspect: null,
    ledgerDays: days.length,
    activeDays: null,
    restDays: null,
  } satisfies OpsCampaignRollup;

  const campaign: OpsCampaign = {
    key: c.key,
    label: c.label,
    displayLabel: c.label,
    productionBatch: rollup.productionBatch,
    campaignYear: 2026,
    firstDate: rollup.firstDate,
    lastDate: rollup.lastDate,
    spanDays: days.length,
    firstFedDate: null,
    lastFedDate: null,
    feedDays: 0,
    blocks,
  };

  const gradeKg = Object.fromEntries(
    GRADES.map((g) => [g, sumOf(days.map((d) => d.producedByGrade[g] ?? null))]),
  );

  return { campaign, days, rollup, gradeKg };
}

const DECODED = CAMPAIGNS.map(decodeCampaign);

/** The group row, evaluated exactly as the GROUP formulas state it. */
function fixtureGroup(): OpsGroupRollup {
  const rs = DECODED.map((d) => d.rollup);
  const fed = sumOf(rs.map((r) => r.fedKg))!;
  const prod = sumOf(rs.map((r) => r.producedKg))!;
  const waste = sumOf(rs.map((r) => r.wasteKg))!;
  const incl = sumOf(rs.map((r) => r.campaignFedKgIncluded))!;
  const byIncl = (pick: (r: OpsCampaignRollup) => number | null) =>
    rs.reduce((a, r) => a + (pick(r) ?? 0) * (r.campaignFedKgIncluded ?? 0), 0) / incl;
  const fedPrice = rs.reduce((a, r) => a + (r.fedPhpKg ?? 0) * (r.fedKg ?? 0), 0) / fed;
  const yieldPct = prod / fed;
  return {
    campaignCount: rs.length,
    campaignKeys: rs.map((r) => r.campaignKey),
    campaignsMissing: [],
    firstDate: rs[0].firstDate,
    lastDate: rs[rs.length - 1].lastDate,
    ledgerDays: 0,
    activeDays: 0,
    restDays: 0,
    fedKg: fed,
    producedKg: prod,
    fedKgProductionReported: fed,
    campaignsProductionReported: rs.length,
    yieldPct,
    processLossKg: null,
    processLossPct: 1 - yieldPct,
    blockResikoLossPct: byIncl((r) => r.blocksClosedResikoLossPct),
    waste: Object.fromEntries(
      WASTE_STREAMS.map((s) => [s.key, sumOf(rs.map((r) => r.waste[s.key]))]),
    ) as OpsWaste,
    wasteKg: waste,
    wasteShiftCount: 0,
    wasteLossPct: waste / prod,
    campaignsWasteReported: rs.length,
    producedKgWasteReported: prod,
    fedPhpKg: fedPrice,
    fedValuePhp: null,
    actualFedPhpKg: byIncl((r) => r.campaignWeightedActualFedPhpKg),
    upliftPhpKg: byIncl((r) => r.upliftPhpKg),
    phpPerProducedKgDelivered: fedPrice / yieldPct,
    // SEPTEMBER 2026 is not fully covered, so the strict figure is blank — which is
    // exactly the case the TRUE PC COST formula's `COUNTBLANK` guard exists for.
    phpPerProducedKgTrue: null,
    phpPerProducedKgTrueCovered: null,
    campaignsFullyCovered: rs.filter((r) => r.isFullyCovered).length,
    isFullyCovered: rs.every((r) => r.isFullyCovered),
    coveredFedKgShare: null,
    campaignFedKgIncluded: incl,
    fedPriceCoveragePct: null,
    blocksFedDistinct: 0,
    blocksClosedDistinct: 0,
    blocksOpenDistinct: 0,
    blocksFedCampaignSum: null,
    reportedCampaignDays: null,
    reportedCalendarDays: 0,
    shiftCount: null,
    runCount: null,
    downtimeHours: null,
    sacks: null,
    sundryKg: null,
    blocks: [],
  };
}

function fixtureData(canViewPrices: boolean): OpsLedgerData {
  const strip = <T,>(v: T): T | null => (canViewPrices ? v : null);
  return {
    campaigns: DECODED.map((d) => ({
      ...d.campaign,
      // The adapter nulls every ₱ field server-side BEFORE the payload leaves; the
      // fixture reproduces that, so the builder is exercised against a real
      // price-denied payload rather than against a full one it is asked to hide.
      blocks: d.campaign.blocks.map((b) => ({
        ...b,
        deliveredPhpKg: strip(b.deliveredPhpKg),
        pricedDeliveredPhpKg: strip(b.pricedDeliveredPhpKg),
        actualFedPhpKg: strip(b.actualFedPhpKg),
        upliftPhpKg: strip(b.upliftPhpKg),
      })),
    })),
    campaignsMissing: [],
    days: DECODED.flatMap((d) =>
      d.days.map((day) => ({ ...day, fedPhpKg: strip(day.fedPhpKg) })),
    ),
    rollups: DECODED.map((d) => ({
      ...d.rollup,
      fedPhpKg: strip(d.rollup.fedPhpKg),
      fedValuePhp: strip(d.rollup.fedValuePhp),
      actualFedPhpKg: strip(d.rollup.actualFedPhpKg),
      campaignWeightedActualFedPhpKg: strip(d.rollup.campaignWeightedActualFedPhpKg),
      upliftPhpKg: strip(d.rollup.upliftPhpKg),
      phpPerProducedKgDelivered: strip(d.rollup.phpPerProducedKgDelivered),
      phpPerProducedKgTrue: strip(d.rollup.phpPerProducedKgTrue),
    })),
    group: fixtureGroup(),
    grades: GRADES,
    gradesByCampaign: Object.fromEntries(
      DECODED.map((d) => [
        d.campaign.key,
        GRADES.map((g) => ({
          campaignKey: d.campaign.key,
          grade: g,
          kg: d.gradeKg[g],
          sharePct: null,
          campaignProducedKg: null,
          runCount: null,
          sacks: null,
        })),
      ]),
    ),
    canViewPrices,
  };
}

/**
 * THE DEGENERATE CAMPAIGN — one day, nothing fed, nothing produced, no block, no
 * price. It is not a contrived shape: 22 of the 32 campaigns filed no production
 * shift at all, every campaign's opening days have no CLOSED block, and SEPTEMBER
 * 2026 opened three days before its first feed. Every yield, every ratio and every
 * ₱/kg on this tab has an undefined denominator, which is exactly what the
 * `divBlank` guards are for.
 */
function emptyFixture(): OpsExcelInput {
  const nullWaste = Object.fromEntries(WASTE_STREAMS.map((s) => [s.key, null])) as OpsWaste;
  const key = 'OCTOBER-2026';
  const label = 'OCTOBER 2026';
  const date = '2026-10-01';
  const day: OpsLedgerDay = {
    campaignKey: key,
    campaignLabel: label,
    date,
    weekday: 'Thu',
    isoWeekday: 4,
    isWeekend: false,
    isRestDay: true,
    fedKg: null,
    sundryKg: null,
    fedPhpKg: null,
    producedKg: null,
    dayDriftKg: null,
    blocksFedCount: 0,
    shiftCount: 0,
    shiftHrsTotal: null,
    downtimeHours: null,
    downtimeIncidentCount: 0,
    downtimeShiftCount: 0,
    downtimeShiftsWithDuration: 0,
    downtimeShiftsReasonOnly: 0,
    runCount: 0,
    sacks: null,
    runsWithSacks: 0,
    waste: nullWaste,
    totalWasteKg: null,
    productionReported: false,
    wastePct: null,
    yieldPct: null,
    lossPct: null,
    producedByGrade: {},
    blocksFed: [],
    fedBlend: null,
    shifts: [],
  };
  const base = DECODED[0].rollup;
  const rollup: OpsCampaignRollup = {
    ...base,
    campaignKey: key,
    label,
    productionBatch: 'OCTOBER',
    firstDate: date,
    lastDate: date,
    spanDays: 1,
    fedKg: null,
    producedKg: null,
    productionReported: false,
    yieldPct: null,
    processLossPct: null,
    blockResikoKg: null,
    blockResikoLossPct: null,
    blocksDeliveredKg: null,
    blocksResikoKg: null,
    blocksClosedResikoLossPct: null,
    waste: nullWaste,
    wasteKg: null,
    wasteLossPct: null,
    fedPhpKg: null,
    actualFedPhpKg: null,
    campaignWeightedActualFedPhpKg: null,
    upliftPhpKg: null,
    phpPerProducedKgDelivered: null,
    phpPerProducedKgTrue: null,
    blocksFed: 0,
    blocksClosed: 0,
    blocksOpen: 0,
    blocksInPrice: 0,
    campaignFedKgIncluded: null,
    isFullyCovered: false,
    ledgerDays: 1,
  };
  return toExcelInput(
    {
      campaigns: [{ ...DECODED[0].campaign, key, label, displayLabel: label, blocks: [] }],
      campaignsMissing: [],
      days: [day],
      rollups: [rollup],
      // A ONE-CAMPAIGN SELECTION HAS NO GROUP ROW TO WEIGHT — `null` is what the
      // adapter hands the page, so it is what the builder must survive.
      group: null,
      grades: [],
      gradesByCampaign: { [key]: [] },
      canViewPrices: true,
    },
    'OCTOBER 2026',
    '2026-10-01',
  );
}

// ═══ REFERENCE PARSING ════════════════════════════════════════════════════════
// Formula strings carry literals (`"CLOSED"`, `" closed · "`), so quoted text is
// stripped BEFORE a reference is looked for — otherwise `"OK*"` reads as a column.

const STRING_LITERAL = /"(?:[^"]|"")*"/g;
const REF =
  /(?:'((?:[^']|'')+)'!)?(\$?[A-Z]{1,3}\$?\d{1,7})(?::(\$?[A-Z]{1,3}\$?\d{1,7}))?/g;

interface Ref {
  sheet: string | null;
  from: string;
  to: string | null;
}

/** `'Checks'!F:F` — a whole-column reference, which carries no row number. */
const COL_REF = /(?:'((?:[^']|'')+)'!)?\$?([A-Z]{1,3})\$?:\$?[A-Z]{1,3}\$?(?!\d)/g;

function colRefsIn(formula: string): Array<{ sheet: string | null }> {
  const cleaned = formula.replace(STRING_LITERAL, '""');
  return [...cleaned.matchAll(COL_REF)].map((m) => ({
    sheet: m[1] ? m[1].replace(/''/g, "'") : null,
  }));
}

function refsIn(formula: string): Ref[] {
  const cleaned = formula.replace(STRING_LITERAL, '""');
  const out: Ref[] = [];
  for (const m of cleaned.matchAll(REF)) {
    const before = m.index === 0 ? '' : cleaned[m.index - 1];
    // Guard against a match inside a longer token (a defined name, a function).
    if (/[A-Z0-9_$.]/.test(before) && before !== '!' && before !== '$') continue;
    out.push({
      sheet: m[1] ? m[1].replace(/''/g, "'") : null,
      from: m[2].replace(/\$/g, ''),
      to: m[3] ? m[3].replace(/\$/g, '') : null,
    });
  }
  return out;
}

function addrToRC(addr: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(addr);
  if (!m) throw new Error(`not an A1 address: ${addr}`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

const cellIsWritten = (ws: ExcelJS.Worksheet, addr: string): boolean => {
  const c = ws.getCell(addr);
  return c.value !== null && c.value !== undefined && c.value !== '';
};

/** Frozen panes, ignoring the zoom/gridline defaults ExcelJS fills in on read. */
function assertFrozen(ws: ExcelJS.Worksheet, xSplit: number, ySplit: number): void {
  const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
  assert.strictEqual(view?.state, 'frozen', `${ws.name}: panes must be frozen`);
  assert.strictEqual(view?.xSplit ?? 0, xSplit, `${ws.name}: frozen columns`);
  assert.strictEqual(view?.ySplit ?? 0, ySplit, `${ws.name}: frozen rows`);
}

async function reopen(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

type CellVisit = (ws: ExcelJS.Worksheet, cell: ExcelJS.Cell) => void;
/**
 * Every REAL cell of every sheet, exactly once.
 *
 * A MERGED RANGE'S SLAVE CELLS ARE SKIPPED. ExcelJS hands a slave its master's
 * value, so a merged formula (the BLOCKS USED footer caption, the EOQ CHECKS line)
 * would otherwise be counted once per covered cell — measured, 15 phantom formulas
 * against the 1,075 the file actually contains, which is how a cell count stops
 * agreeing with the XML.
 */
function walk(wb: ExcelJS.Workbook, visit: CellVisit): void {
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const master = (cell as { master?: ExcelJS.Cell }).master;
        if (master && master.address !== cell.address) return;
        visit(ws, cell);
      });
    });
  }
}

const isFormula = (v: unknown): v is { formula: string; result?: unknown } =>
  typeof v === 'object' && v !== null && 'formula' in (v as Record<string, unknown>);

const near = (a: number | null | undefined, b: number | null, eps = 1e-6): boolean => {
  if (a === null || a === undefined) return b === null;
  if (b === null) return false;
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
};

// ═══ RUN ══════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\nOperations Excel export — the workbook\n');

  const allowed = toExcelInput(fixtureData(true), 'Q3 2026', '2026-09-17');
  const denied = toExcelInput(fixtureData(false), 'Q3 2026', '2026-09-17');
  const built = await buildOpsWorkbook(allowed);
  const builtDenied = await buildOpsWorkbook(denied);
  const wb = await reopen(built.buffer);
  const wbDenied = await reopen(builtDenied.buffer);

  const july = wb.getWorksheet('JULY 2026')!;
  const eoq = wb.getWorksheet('EOQ Summary')!;
  const rc = wb.getWorksheet('RC Movement')!;
  const checks = wb.getWorksheet('Checks')!;

  // ── 0 · the file itself ────────────────────────────────────────────────────
  await check('six tabs, in Renzo\'s order, with the group in the file name', () => {
    assert.deepStrictEqual(built.sheetNames, [
      'EOQ Summary',
      'JULY 2026',
      'AUGUST 2026',
      'SEPTEMBER 2026',
      'RC Movement',
      'Checks',
    ]);
    assert.strictEqual(built.filename, 'Blackwood Operations — Q3 2026.xlsx');
    assert.strictEqual(opsExcelFilename('Q3 2026'), built.filename);
  });

  await check('Excel is told to recalculate on open', () => {
    // Without this the cached results would be the LAST word rather than the first.
    // Read it out of the FILE: ExcelJS writes `calcPr` but does not parse it back,
    // so asserting on the re-opened object would pass vacuously.
    const xml = new TextDecoder().decode(
      unzipSync(new Uint8Array(built.buffer))['xl/workbook.xml'],
    );
    assert.match(xml, /<calcPr[^>]*fullCalcOnLoad="1"/);
  });

  // ── a · every formula reference resolves ───────────────────────────────────
  let formulaCount = 0;
  let crossTabCount = 0;
  await check('(a) every formula targets a sheet and a cell that exist', () => {
    const names = new Set(wb.worksheets.map((w) => w.name));
    const problems: string[] = [];
    walk(wb, (ws, cell) => {
      const v = cell.value;
      if (!isFormula(v)) return;
      formulaCount += 1;
      const refs = refsIn(v.formula);
      const colRefs = colRefsIn(v.formula);
      assert.ok(
        refs.length > 0 || colRefs.length > 0,
        `${ws.name}!${cell.address} has a formula with no reference: ${v.formula}`,
      );
      for (const cr of colRefs) {
        const targetName = cr.sheet ?? ws.name;
        if (!names.has(targetName)) {
          problems.push(`${ws.name}!${cell.address} → unknown sheet '${targetName}'`);
        }
      }
      for (const ref of refs) {
        const targetName = ref.sheet ?? ws.name;
        if (!names.has(targetName)) {
          problems.push(`${ws.name}!${cell.address} → unknown sheet '${targetName}'`);
          continue;
        }
        const target = wb.getWorksheet(targetName)!;
        for (const addr of [ref.from, ref.to].filter(Boolean) as string[]) {
          const { row, col } = addrToRC(addr);
          if (row < 1 || col < 1) problems.push(`${ws.name}!${cell.address} → ${addr}`);
        }
        // A CROSS-TAB SINGLE-CELL LINK MUST LAND ON SOMETHING. This is the check
        // that matters: Excel renders a link to an empty cell as 0, not as an error.
        if (ref.sheet && !ref.to) {
          crossTabCount += 1;
          // A link the formula explicitly GUARDS (`IF(ref="","",ref)` — the
          // passBlank idiom) is allowed to land on an empty cell: that is how a
          // deliberate blank (an open block has no ACTUAL PRICE) crosses a tab
          // boundary without becoming a 0. An UNGUARDED link must land on a value.
          const guarded = v.formula.includes(`'${targetName}'!${ref.from}=""`);
          if (!guarded && !cellIsWritten(target, ref.from)) {
            problems.push(
              `${ws.name}!${cell.address} links to '${targetName}'!${ref.from}, which is empty`,
            );
          }
        }
      }
    });
    assert.deepStrictEqual(problems, [], problems.join('\n'));
    assert.ok(formulaCount > 900, `expected a formula-heavy workbook, got ${formulaCount}`);
    assert.ok(crossTabCount > 100, `expected many cross-tab links, got ${crossTabCount}`);
  });

  await check('(a) the ledger and the matrix are LINKED, not two copies of the kg', () => {
    // JULY's first day: the month tab's TTL FED must be a formula pointing at the
    // RC Movement row total for that same date, and nothing else.
    const cell = july.getCell('D9').value;
    assert.ok(isFormula(cell), 'TTL FED must be a formula');
    assert.match(cell.formula, /^'RC Movement'!E\d+$/);
    // …and BLOCKS USED' FED WT must point at that block's COLUMN total.
    const blocksFirst = 9 + DECODED[0].days.length + 1 + 4;
    const fedWt = july.getCell(`F${blocksFirst}`).value;
    assert.ok(isFormula(fedWt), 'FED WT must be a formula');
    assert.match(fedWt.formula, /^'RC Movement'![A-Z]+\d+$/);
  });

  // ── b · cached results are the payload's figures ───────────────────────────
  await check('(b) the day rows cache the payload, kilogram for kilogram', () => {
    const days = DECODED[0].days;
    days.forEach((day, i) => {
      const r = 9 + i;
      const fed = july.getCell(`D${r}`).value;
      assert.ok(isFormula(fed));
      assert.ok(
        near(fed.result as number, day.fedKg),
        `JULY row ${r}: TTL FED cached ${String(fed.result)} for ${String(day.fedKg)}`,
      );
      const prod = july.getCell(`E${r}`).value;
      assert.ok(isFormula(prod));
      assert.ok(
        near(prod.result as number, day.producedKg),
        `JULY row ${r}: TTL PROD cached ${String(prod.result)} for ${String(day.producedKg)}`,
      );
      const waste = july.getCell(`F${r}`).value;
      assert.ok(isFormula(waste));
      assert.ok(near(waste.result as number, day.totalWasteKg), `JULY row ${r}: WASTE`);
    });
  });

  await check('(b) the totals row and the EOM rollup cache the campaign KPIs', () => {
    const totalsRow = 9 + DECODED[0].days.length;
    const k = KPIS['JULY-2026'];
    const fedTotal = july.getCell(`D${totalsRow}`).value;
    assert.ok(isFormula(fedTotal) && near(fedTotal.result as number, k.fed));
    const prodTotal = july.getCell(`E${totalsRow}`).value;
    assert.ok(isFormula(prodTotal) && near(prodTotal.result as number, k.prod));
    const pairs: Array<[string, number | null]> = [
      ['B4', k.fed === null ? null : k.fed / 1000],
      ['C4', k.prod === null ? null : k.prod / 1000],
      ['D4', k.yield],
      ['E4', k.loss],
      ['F4', k.waste],
      ['G4', k.waste_pct],
      ['H4', k.fed_price],
      ['I4', k.actual],
      ['J4', k.uplift],
      ['K4', k.resiko_loss],
      ['L4', k.pc],
      ['M4', k.true_pc],
      ['N4', k.incl_kg],
    ];
    for (const [addr, want] of pairs) {
      const v = july.getCell(addr).value;
      assert.ok(isFormula(v), `${addr} must be a formula`);
      assert.ok(
        near(v.result as number, want),
        `EOM ${addr}: cached ${String(v.result)}, database ${String(want)}`,
      );
    }
  });

  await check('(b) the EOQ campaign rows cache the same figures their links point at', () => {
    CAMPAIGNS.forEach((c, i) => {
      const k = KPIS[c.key];
      const row = 4 + i;
      const fed = eoq.getCell(`B${row}`).value;
      assert.ok(isFormula(fed));
      assert.ok(near(fed.result as number, k.fed === null ? null : k.fed / 1000), `EOQ B${row}`);
      assert.match(fed.formula, new RegExp(`^'${c.label}'!B4$`));
      const truePc = eoq.getCell(`M${row}`).value;
      assert.ok(isFormula(truePc));
      // SEPTEMBER's TRUE PC COST is blank on purpose — the link must carry the
      // blank across rather than turning it into a 0.
      assert.match(truePc.formula, /^IF\('.+'!M4="","",'.+'!M4\)$/);
      assert.ok(near(truePc.result as number, k.true_pc), `EOQ M${row}`);
    });
  });

  await check('(b) the RC Movement column totals cache each block\'s campaign fed kg', () => {
    const blocks = DECODED[0].campaign.blocks;
    const totalRow = 5 + DECODED[0].days.length + 1; // header rows 4-5, days from 6
    blocks.forEach((b, i) => {
      const col = String.fromCharCode('F'.charCodeAt(0) + i);
      const v = rc.getCell(`${col}${totalRow}`).value;
      assert.ok(isFormula(v), `RC ${col}${totalRow} must be a formula`);
      assert.ok(
        near(v.result as number, b.campaignFedKg),
        `RC ${col}${totalRow}: cached ${String(v.result)} for ${b.batchCode}`,
      );
    });
  });

  // ── c · sheet names ────────────────────────────────────────────────────────
  await check('(c) every sheet name fits Excel, and every reference quotes it', () => {
    for (const ws of wb.worksheets) {
      assert.ok(ws.name.length <= 31, `${ws.name} is ${ws.name.length} chars`);
      assert.ok(!/[[\]:*?/\\]/.test(ws.name), `${ws.name} carries an illegal character`);
    }
    const names = wb.worksheets.map((w) => w.name);
    walk(wb, (ws, cell) => {
      const v = cell.value;
      if (!isFormula(v)) return;
      const body = v.formula.replace(STRING_LITERAL, '""');
      for (const name of names) {
        // An unquoted sheet name followed by `!` is the failure mode this catches.
        const bad = new RegExp(`(^|[^'A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}!`);
        assert.ok(
          !bad.test(body),
          `${ws.name}!${cell.address} references ${name} unquoted: ${v.formula}`,
        );
      }
    });
  });

  // ── d · the price-denied build ─────────────────────────────────────────────
  await check('(d) the price-denied build carries no ₱ anywhere it can be read', () => {
    const PRICE_WORDS = /₱|php|peso/i;
    const offences: string[] = [];
    walk(wbDenied, (ws, cell) => {
      const v = cell.value;
      const texts: string[] = [];
      if (typeof v === 'string') texts.push(v);
      if (isFormula(v)) {
        texts.push(v.formula);
        if (typeof v.result === 'string') texts.push(v.result);
      }
      if (cell.numFmt) texts.push(cell.numFmt);
      const note = cell.note as unknown;
      if (typeof note === 'string') texts.push(note);
      else if (note && typeof note === 'object' && 'texts' in note) {
        for (const t of (note as { texts: { text: string }[] }).texts) texts.push(t.text);
      }
      for (const t of texts) {
        if (PRICE_WORDS.test(t)) offences.push(`${ws.name}!${cell.address}: ${t.slice(0, 90)}`);
      }
    });
    assert.deepStrictEqual(offences, [], offences.slice(0, 8).join('\n'));
  });

  await check('(d) the ₱ COLUMNS are absent, not blanked and not hidden', () => {
    const jd = wbDenied.getWorksheet('JULY 2026')!;
    // FED PRICE is gone, so TTL FED moves from D to C and the whole ledger shifts.
    assert.strictEqual(jd.getCell('C8').value, 'TTL FED kg');
    assert.strictEqual(jd.getCell('D8').value, 'TTL PROD kg');
    // The EOM rollup keeps its non-₱ metrics and loses the five ₱ ones.
    const labels = ['B3', 'C3', 'D3', 'E3', 'F3', 'G3', 'H3', 'I3'].map(
      (a) => jd.getCell(a).value,
    );
    assert.deepStrictEqual(labels, [
      'RC FED (t)',
      'PRODUCED (t)',
      'YIELD',
      'LOSS',
      'WASTE (kg)',
      'WASTE %',
      'RESIKO LOSS',
      'fed kg in price set',
    ]);
    assert.strictEqual(jd.getCell('J3').value, null, 'nothing may sit past the last metric');
    for (const ws of wbDenied.worksheets) {
      ws.columns?.forEach((c, i) => {
        assert.ok(!c.hidden, `${ws.name} column ${i + 1} is hidden — columns must be ABSENT`);
      });
    }
    assert.strictEqual(builtDenied.containsPrices, false);
  });

  await check('(d) the price-denied Checks tab drops the five ₱ rows', () => {
    const cd = wbDenied.getWorksheet('Checks')!;
    const figures = new Set<string>();
    cd.eachRow({ includeEmpty: false }, (row, n) => {
      if (n >= 5) figures.add(String(row.getCell(2).value ?? ''));
    });
    for (const gone of ['Fed price', 'Actual fed price', 'Resiko cost', 'PC cost', 'True PC cost']) {
      assert.ok(!figures.has(gone), `"${gone}" must not be checked for a price-denied reader`);
    }
    for (const kept of ['RC fed kg', 'Produced kg', 'Yield', 'Waste %', 'Resiko loss']) {
      assert.ok(figures.has(kept), `"${kept}" carries no money and must stay`);
    }
  });

  // ── e · the GROUP row's deliberate refusal ─────────────────────────────────
  await check('(e) the GROUP row publishes no resiko KG — only the ratio', () => {
    const groupRow = 4 + CAMPAIGNS.length;
    assert.strictEqual(eoq.getCell(`A${groupRow}`).value, 'GROUP · Q3 2026');
    // There is no resiko-KG column on this tab at all, and the RESIKO LOSS cell
    // beside it is a weighted RATIO, never a sum.
    const ratio = eoq.getCell(`K${groupRow}`).value;
    assert.ok(isFormula(ratio));
    // A WEIGHTED RATIO, and the weight is each campaign's fed kg inside its price
    // set (column N) — never a plain sum of the three campaigns' percentages.
    assert.match(ratio.formula, /SUMPRODUCT\(K4:K6,N4:N6\)\/SUM\(N4:N6\)/);
    assert.ok(!/SUM\(K4:K6\)/.test(ratio.formula), 'a resiko ratio must never be summed');
    // …and no column on this tab states resiko in KILOGRAMS. The refusal is
    // STRUCTURAL — there is no cell to blank — because a block fed by two
    // campaigns (78 of 523) would have its shrinkage counted once per campaign.
    const eoqHeaders: string[] = [];
    eoq.getRow(3).eachCell({ includeEmpty: false }, (c) => eoqHeaders.push(String(c.value ?? '')));
    for (const h of eoqHeaders) {
      assert.ok(
        !/resiko\s*(kg|weight)/i.test(h),
        `the EOQ tab must publish no resiko-kg column, found "${h}"`,
      );
    }
    // The month tab DOES carry one (a single campaign can own its blocks' kg), so
    // the absence above is a decision about the GROUP, not a missing feature.
    const totalsRow = 9 + DECODED[0].days.length;
    assert.strictEqual(july.getCell(`H${totalsRow + 4}`).value, 'RESIKO kg');
    const note = eoq.getCell(`K${groupRow}`).note as unknown;
    const noteText =
      note && typeof note === 'object' && 'texts' in note
        ? (note as { texts: { text: string }[] }).texts.map((t) => t.text).join('')
        : String(note ?? '');
    assert.match(noteText, /counted twice/);
  });

  // ── f · the layout Renzo settled on (plan §10) ─────────────────────────────
  await check('(f) EOQ Summary: title r1 · header r3 · campaigns r4-6 · GROUP r7 · CHECKS r9', () => {
    assert.strictEqual(eoq.getCell('A1').value, 'EOQ SUMMARY — Q3 2026');
    assert.strictEqual(eoq.getCell('A2').value, null, 'round 2 removed the subtitle line');
    assert.strictEqual(eoq.getCell('A3').value, 'CAMPAIGN');
    assert.strictEqual(eoq.getCell('A4').value, 'JULY 2026');
    assert.strictEqual(eoq.getCell('A5').value, 'AUGUST 2026');
    assert.strictEqual(eoq.getCell('A6').value, 'SEPTEMBER 2026');
    assert.strictEqual(eoq.getCell('A7').value, 'GROUP · Q3 2026');
    assert.strictEqual(eoq.getCell('A8').value, null);
    assert.strictEqual(eoq.getCell('A9').value, 'CHECKS');
    assert.ok(!eoq.getRow(9).hidden, 'round 2 keeps the CHECKS line VISIBLE');
    assertFrozen(eoq, 1, 3);
  });

  await check('(f) a month tab: rollup r3/r4 · band r7 · headers r8 · first day r9', () => {
    assert.strictEqual(july.getCell('A1').value, 'JULY 2026 — PLANT OPERATIONS');
    assert.strictEqual(july.getCell('A2').value, null, 'round 2 removed the subtitle line');
    assert.strictEqual(july.getCell('A3').value, 'EOM ROLLUP');
    assert.strictEqual(july.getCell('A4').value, 'JULY 2026');
    assert.strictEqual(july.getCell('A7').value, 'DAY');
    assert.strictEqual(july.getCell('C7').value, 'PRICE');
    assert.strictEqual(july.getCell('A8').value, 'DATE');
    assert.strictEqual(july.getCell('D8').value, 'TTL FED kg');
    assert.ok(july.getCell('A9').value instanceof Date, 'the first day is row 9');
    // …and the band strip is CENTRED (round 1, rule 4).
    assert.strictEqual(july.getCell('A7').alignment?.horizontal, 'center');
    // …and column A is 18.16 wide (round 1, rule 3).
    assert.strictEqual(july.getColumn(1).width, 18.16);
  });

  await check('(f) RC Movement: title r1 · first table title r3 · headers r4/5 · day r6 · freeze F3', () => {
    assert.strictEqual(rc.getCell('A1').value, 'RC MOVEMENT — Q3 2026');
    assert.strictEqual(rc.getCell('A2').value, null, 'round 2 removed the legend line');
    assert.match(String(rc.getCell('A3').value), /^JULY 2026 · /);
    assert.strictEqual(rc.getCell('A4').value, '#');
    assert.strictEqual(rc.getCell('D4').value, 'FED ₱/kg');
    assert.strictEqual(rc.getCell('E4').value, 'TOTAL FED kg');
    assert.strictEqual(rc.getCell('F5').value !== null, true, 'block loc sub-label on row 5');
    assert.strictEqual(rc.getCell('A6').value, 1, 'the first day is row 6');
    assertFrozen(rc, 5, 2);
  });

  await check('(f) the three green footer rows sit under each matrix', () => {
    const totalRow = 5 + DECODED[0].days.length + 1;
    assert.strictEqual(rc.getCell(`B${totalRow}`).value, 'FED kg (this campaign)');
    assert.strictEqual(rc.getCell(`B${totalRow + 1}`).value, '₱/KG (block price)');
    assert.strictEqual(rc.getCell(`B${totalRow + 2}`).value, 'LOSS % (resiko)');
    assert.strictEqual(rc.getCell(`B${totalRow + 3}`).value, 'ACTUAL ₱/kg');
    // GREEN is the one colour Renzo's black-text edit deliberately left alone.
    assert.strictEqual(rc.getCell(`F${totalRow + 1}`).font?.color?.argb, 'FF008000');
    // …and every other font on a day row is black (i.e. carries no colour).
    assert.strictEqual(rc.getCell('B6').font?.color, undefined);
  });

  await check('(f) BLOCKS USED sits three rows under the totals, with its one note', () => {
    const totalsRow = 9 + DECODED[0].days.length;
    const titleRow = totalsRow + 3;
    assert.strictEqual(july.getCell(`A${titleRow}`).value, 'BLOCKS USED');
    assert.match(String(july.getCell(`D${titleRow}`).value), /^FED WT is this campaign's kg/);
    assert.strictEqual(july.getCell(`A${titleRow + 1}`).value, 'BATCH');
    assert.strictEqual(july.getCell(`F${titleRow + 1}`).value, 'FED WT kg');
    assert.strictEqual(july.getCell(`M${titleRow + 1}`).value, 'IN PRICE SET');
  });

  // ── dates ──────────────────────────────────────────────────────────────────
  await check('dates are Excel BUILT-IN Short Date (numFmtId 14), never a literal pattern', () => {
    // The pattern string is what the libraries MAP onto the built-in id; the proof
    // is in the file, so read the file. A custom numFmt would freeze the date into
    // one locale and stop it reading `6/30/2026` on Renzo's Mac.
    const files = unzipSync(new Uint8Array(built.buffer));
    const styles = new TextDecoder().decode(files['xl/styles.xml']);
    const declared = [...styles.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)];
    for (const [, id, code] of declared) {
      assert.ok(
        !/^mm-dd-yy$/i.test(code),
        `the date format was written as a CUSTOM numFmt (id ${id}) instead of built-in 14`,
      );
    }
    const usesBuiltin14 = /<xf[^>]*numFmtId="14"/.test(styles);
    assert.ok(usesBuiltin14, 'no cell style uses the built-in Short Date (numFmtId 14)');
    // …and the date value itself is a real date, on the right day.
    const d = july.getCell('A9').value as Date;
    assert.strictEqual(d.toISOString().slice(0, 10), DECODED[0].days[0].date);
  });

  await check('a rest day is a BLANK row, never a row of zeroes', () => {
    const rest = DECODED[0].days.findIndex((d) => d.isRestDay);
    assert.ok(rest >= 0, 'the JULY fixture must contain a rest day');
    const r = 9 + rest;
    for (const col of ['C', 'H', 'I', 'J', 'O']) {
      const v = july.getCell(`${col}${r}`).value;
      assert.ok(v === null || v === undefined, `${col}${r} must be empty on a rest day, got ${String(v)}`);
    }
  });

  await check('an OPEN block shows no resiko, and says why in a comment', () => {
    const totalsRow = 9 + DECODED[0].days.length;
    const b1 = totalsRow + 5;
    const openIdx = DECODED[0].campaign.blocks.findIndex((b) => !b.isClosed);
    if (openIdx < 0) return; // JULY closed every block it fed — nothing to assert
    const cell = july.getCell(`H${b1 + openIdx}`);
    assert.ok(cell.value === null || cell.value === undefined);
    const note = cell.note as unknown as { texts: { text: string }[] };
    assert.match(note.texts.map((t) => t.text).join(''), /Not a loss yet/);
  });

  await check('the Checks tab compares the workbook against the database, row by row', () => {
    assert.match(String(checks.getCell('A1').value), /^CHECKS —/);
    assert.match(String(checks.getCell('A2').value), /published on 2026-09-17/);
    assert.strictEqual(checks.getCell('C4').value, 'WORKBOOK');
    assert.strictEqual(checks.getCell('D4').value, 'DATABASE');
    const workbookCell = checks.getCell('C5').value;
    assert.ok(isFormula(workbookCell));
    assert.match(workbookCell.formula, /^IF\('JULY 2026'!/);
    // The DATABASE column is a typed VALUE — if it were a formula it would not be
    // an independent witness.
    assert.strictEqual(typeof checks.getCell('D5').value, 'number');
    assert.ok(near(checks.getCell('D5').value as number, KPIS['JULY-2026'].fed));
  });

  // ── every formula carries a cached result ───────────────────────────────────
  await check('every formula in the FILE carries a cached <v>, not one is naked', () => {
    // THE CACHE IS WHAT A NON-RECALCULATING VIEWER SHOWS — an email preview, a phone
    // quick-look, a Google Sheets import. A formula with no cached value renders
    // there as an empty cell, which for a total is indistinguishable from "nothing
    // happened".
    //
    // READ THE FILE, NOT THE LIBRARY. ExcelJS's reader drops a FALSY cached result,
    // so a legitimate `<v>0</v>` (a Checks difference of zero) and a deliberate
    // `<v></v>` (TRUE PC COST before every block closes) both come back as `result:
    // undefined` — asserting on the re-opened object would report ~40 phantom
    // failures and could never see a genuinely naked formula. The XML is exact.
    const files = unzipSync(new Uint8Array(built.buffer));
    const sheetXml = Object.keys(files).filter((f) =>
      /^xl\/worksheets\/sheet\d+\.xml$/.test(f),
    );
    assert.strictEqual(sheetXml.length, 6, 'six worksheet parts');
    const naked: string[] = [];
    let withValue = 0;
    let blank = 0;
    for (const name of sheetXml) {
      const xml = new TextDecoder().decode(files[name]);
      for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(.*?)<\/c>/g)) {
        const [, ref, body] = m;
        if (!body.includes('<f>')) continue;
        if (/<v><\/v>|<v\/>/.test(body)) blank += 1;
        else if (/<v>[^<]*<\/v>/.test(body)) withValue += 1;
        else naked.push(`${name} ${ref}: ${body.slice(0, 110)}`);
      }
    }
    assert.deepStrictEqual(naked, [], naked.slice(0, 10).join('\n'));
    assert.ok(withValue > 900, `expected most formulas to cache a figure, got ${withValue}`);
    // …and the deliberate-blank path is actually exercised, so this is not vacuous:
    // SEPTEMBER 2026's TRUE PC COST is blank because one of its blocks is still open.
    assert.ok(blank > 0, 'no formula cached a deliberate blank — is the fixture right?');
    assert.strictEqual(withValue + blank, formulaCount, 'every formula was accounted for');
  });

  // ── no formula can print #DIV/0! ────────────────────────────────────────────
  /**
   * A DIVISION MUST BE GUARDED, and this is a STATIC audit of every one of them.
   *
   * Three things reach a division in this workbook and only one is a zero
   * denominator: an empty price set or an unproductive campaign divides by 0
   * (`#DIV/0!`), and a denominator CELL holding another formula's `""` raises
   * `#VALUE!` — including through `SUMPRODUCT`. An error glyph in a workbook Renzo
   * emails is a bug, so the only accepted shapes are `IFERROR(…)`, the
   * `IF(<den>>0,…)` test (valid ONLY where the denominator is a SUM over value
   * cells, so it is always numeric) and division by a bare literal (`/1000`).
   */
  const auditDivisions = (workbook: ExcelJS.Workbook, label: string): number => {
    const unguarded: string[] = [];
    let divisions = 0;
    walk(workbook, (ws, cell) => {
      const v = cell.value;
      if (!isFormula(v)) return;
      const body = v.formula.replace(STRING_LITERAL, '""');
      // A LITERAL denominator cannot be zero — `/1000` is the kg→tonne conversion.
      const risky = body.replace(/\/\s*\d+(\.\d+)?/g, '');
      if (!risky.includes('/')) return;
      divisions += 1;
      if (/IFERROR\(/.test(body)) return;
      // Without IFERROR the ONLY accepted shape is a positivity test on THIS
      // division's own denominator — and it is accepted only because such a
      // denominator is a plain VALUE cell, which compares as 0 when blank. (A
      // FORMULA cell holding `""` compares GREATER than any number, which is why
      // the rollup cannot be guarded this way at all.)
      for (const m of risky.matchAll(/\/\s*(\$?[A-Z]{1,3}\$?\d{1,7})\b/g)) {
        const den = m[1].replace(/\$/g, '');
        if (!new RegExp(`${den}\\s*>\\s*0`).test(risky)) {
          unguarded.push(`${label} ${ws.name}!${cell.address} = ${v.formula}`);
          return;
        }
      }
      // A denominator that is not a bare cell reference (a SUM, a SUMPRODUCT, a
      // parenthesised expression) can only be guarded by IFERROR.
      if (/\/\s*[^$A-Z]/.test(risky) || /\/\s*[A-Z]{1,3}[^0-9]/.test(risky)) {
        unguarded.push(`${label} ${ws.name}!${cell.address} = ${v.formula}`);
      }
    });
    assert.deepStrictEqual(unguarded, [], unguarded.slice(0, 10).join('\n'));
    return divisions;
  };

  await check('no division is unguarded — a report may never print #DIV/0!', () => {
    const allowedDivs = auditDivisions(wb, 'allowed');
    const deniedDivs = auditDivisions(wbDenied, 'denied');
    assert.ok(allowedDivs > 20, `expected many guarded divisions, audited ${allowedDivs}`);
    // The price-denied build keeps the kg ratios and loses the ₱ ones, so it must
    // still have divisions to audit — otherwise this check passes vacuously.
    assert.ok(deniedDivs > 0, `the denied build audited ${deniedDivs} divisions`);
  });

  // ── d (continued) · not one ₱ HEADER survives the price gate ────────────────
  await check('(d) every ₱ column header of the full build is absent from the denied one', () => {
    // The label list is DERIVED FROM THE CODE'S OWN OUTPUT, never hand-kept: every
    // string anywhere in the price-allowed workbook that carries a ₱ must appear
    // nowhere at all in the price-denied one.
    const phpLabels = new Set<string>();
    walk(wb, (_ws, cell) => {
      const v = cell.value;
      if (typeof v === 'string' && v.includes('₱')) phpLabels.add(v);
    });
    assert.ok(phpLabels.size >= 8, `expected the ₱ labels to be found, got ${phpLabels.size}`);
    const survivors: string[] = [];
    walk(wbDenied, (ws, cell) => {
      const v = cell.value;
      const text = typeof v === 'string' ? v : isFormula(v) ? v.formula : null;
      if (!text) return;
      for (const label of phpLabels) {
        if (text.includes(label)) survivors.push(`${ws.name}!${cell.address}: ${label}`);
      }
    });
    assert.deepStrictEqual(survivors, [], survivors.slice(0, 8).join('\n'));
    // And the Checks tab's ₱ number formats are gone with them.
    walk(wbDenied, (ws, cell) => {
      assert.ok(
        !/₱/.test(cell.numFmt ?? ''),
        `${ws.name}!${cell.address} keeps a ₱ number format`,
      );
    });
  });

  // ── the degenerate campaign — the case the guards exist for ─────────────────
  await check('a campaign with no production, no blocks and no price builds blank, not broken', () => {
    // EVERY GUARD ABOVE IS ABOUT THIS ROW. 22 of the 32 campaigns filed no
    // production shift at all, a campaign's opening days have no CLOSED block, and
    // SEPTEMBER 2026 opened three days before its first feed — so a selection whose
    // yield, waste %, prices and resiko loss are all undefined is ORDINARY, not a
    // corner case. Nothing may divide, and nothing may become a 0.
    const bare = emptyFixture();
    return buildOpsWorkbook(bare).then(async (res) => {
      const w = await reopen(res.buffer);
      auditDivisions(w, 'degenerate');
      const ws = w.getWorksheet('OCTOBER 2026')!;
      // Row 4 is the EOM rollup: every derived figure must read blank.
      for (const col of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'L']) {
        const v = ws.getCell(`${col}4`).value;
        if (v === null || v === undefined) continue;
        assert.ok(isFormula(v), `${col}4 must be a formula or empty`);
        const r = v.result;
        assert.ok(
          r === undefined || r === null || r === '' || r === 0,
          `${col}4 cached ${String(r)} where the payload has nothing`,
        );
      }
      // …and the workbook still has all its tabs, so the download is a real file.
      assert.deepStrictEqual(res.sheetNames, [
        'EOQ Summary',
        'OCTOBER 2026',
        'RC Movement',
        'Checks',
      ]);
    });
  });

  await check('the file name survives a campaign label with path characters', () => {
    assert.strictEqual(opsExcelFilename('Q3 2026'), 'Blackwood Operations — Q3 2026.xlsx');
    assert.strictEqual(
      opsExcelFilename('JULY/2026:A*B?'),
      'Blackwood Operations — JULY-2026-A-B-.xlsx',
    );
    // The em dash is exactly why the route must send an RFC 5987 `filename*`.
    assert.ok(/—/.test(opsExcelFilename('Q3 2026')));
  });

  // ── a sample for Renzo ─────────────────────────────────────────────────────
  const out = join(FIXTURES, 'generated-ts-v1.xlsx');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, built.buffer);

  // The other two builds, on request, so they can be RECALCULATED by a spreadsheet
  // and read for error glyphs — the only way to prove the division guards from the
  // outside. `OPS_EXCEL_DUMP_DIR=/tmp/x npx tsx scripts/verify-ops-excel.ts`.
  const dumpDir = process.env.OPS_EXCEL_DUMP_DIR;
  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(join(dumpDir, 'price-denied.xlsx'), builtDenied.buffer);
    writeFileSync(join(dumpDir, 'degenerate.xlsx'), (await buildOpsWorkbook(emptyFixture())).buffer);
    console.log(`Price-denied and degenerate workbooks written to ${dumpDir}`);
  }

  console.log(
    `\n${passed} assertions passed. ` +
      `${formulaCount} formulas, ${crossTabCount} cross-tab links, ` +
      `${built.buffer.byteLength.toLocaleString()} bytes.`,
  );
  console.log(`Sample workbook written to ${out}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
