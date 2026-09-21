// ─────────────────────────────────────────────────────────────────────────────
// THE ANALYSIS PAGES, ON PAPER.
//
// The blend proposal's printout is a fully self-contained HTML document printed in a
// hidden iframe (`./print-utils.ts`) — never the live DOM — so it is immune to dark
// mode, Tailwind, the Dialog portal and every transform. These builders append one
// SHEET per chosen page after the existing proposal sheet, from the SAME payload the
// screen renders and through the SAME words and formats (`blend-analysis-text.ts`).
//
// ── WHAT PRINT NEEDS THAT THE SCREEN DOES NOT ───────────────────────────────
// 1. **NO `<tfoot>`.** Chrome REPEATS a `<tfoot>` on every printed page, so a totals
//    row in one reads as a duplicated total — `components/shared/print/
//    print-page-rules.ts` states this outright. Every subtotal and every footer here
//    is an ordinary `<tbody>` row, exactly as on screen.
// 2. **A GROUP MUST NOT BE ORPHANED FROM ITS ROWS.** Each group is its own `<tbody>`;
//    a SMALL group (four rows or fewer) carries `break-inside: avoid` so it travels
//    whole, and a big one is allowed to split because forcing a 24-row group onto one
//    sheet would push a whole page of white space ahead of it. Headings carry
//    `break-after: avoid`, so a title can never be the last thing on a sheet.
// 3. **COLOUR IS IN THE MARKUP AND MUST REACH THE PAPER.** `print-color-adjust: exact`
//    is already set on `body` by the shared `PRINT_CSS`, and the group tints are
//    written as inline `rgb(r g b / 0.18)` from `lens/lens-ramp.ts` — the iframe has no
//    `globals.css`, so a `.lens-band-3` class would mean nothing inside it.
// 4. **A 7pt FLOOR.** Padding is squeezed before the font, exactly as the existing
//    proposal sheet does, and nothing is emitted below 7pt.
//
// ── NOTHING HERE COMPUTES A STATISTIC ───────────────────────────────────────
// Every subtotal and footer figure is the payload's own group / `overall` field. The
// single piece of arithmetic in the file is the same per-ROW `kg × ₱/kg` product the
// screen's price table shows, and it contributes to no total.
// ─────────────────────────────────────────────────────────────────────────────

import { getLabHighlightText, type LabHighlightSpec, type LabMetric } from '@/types/table-settings';

import { rampRgb, type LensRampId } from '../blocking/lens/lens-ramp';
import { ageBandLabel } from '../blocking/lens/age-lens-settings';
import { priceBandLabel } from '../blocking/lens/price-lens-settings';
import type {
  BlendAgeBand,
  BlendAnalysis,
  BlendAnalysisBlockRef,
  BlendAnalysisUnmeasured,
  BlendPriceBlock,
  BlendQualityMetric,
} from '../blocking/types';
import { analysisPages, type BlendAnalysisOptions } from './blend-analysis-options';
import {
  blocksWord,
  EMDASH,
  fmtDays,
  fmtKg,
  fmtPeso,
  fmtPesoNum,
  fmtQuality,
  fmtSharePct,
  fmtWholeDays,
  groupWord,
  naturalMethodNote,
  QUALITY_METRIC_LABELS,
  QUALITY_METRIC_UNITS,
  qualityDecimals,
  snapshotGapNote,
  unmeasuredNote,
  vsMarketCaption,
  vsMarketUnavailableNote,
} from './blend-analysis-text';
import { escapeHtml } from './print-utils';

/**
 * The printed sheets' own CSS, appended after the proposal sheet's.
 *
 * Everything is scoped to `.apage` so it cannot reach the existing document, and the
 * `@page` rule is NOT restated — the proposal sheet already declares A4 landscape at a
 * 10mm margin and one document has one page box.
 */
export const BLEND_ANALYSIS_PRINT_CSS = `
  /* Each analysis page starts on its own sheet, and may run onto more than one. */
  .apage { break-before: page; page-break-before: always; }
  .apage h2 {
    font-size: 12px; margin: 0 0 2px; padding-bottom: 2px;
    border-bottom: 1px solid #000; text-transform: uppercase; letter-spacing: 0.04em;
    break-after: avoid;
  }
  .apage h3 {
    font-size: 9.5pt; font-weight: 700; margin: 10px 0 2px; text-transform: uppercase;
    letter-spacing: 0.03em; break-after: avoid;
  }
  .apage .anote { font-size: 8pt; color: #444; margin: 0 0 5px; line-height: 1.35; break-after: avoid; }
  .apage .afoot-note { font-size: 7.5pt; color: #555; margin: 3px 0 0; line-height: 1.3; }
  .apage table.atab { width: 100%; border-collapse: collapse; font-size: 8pt; table-layout: fixed; }
  .apage table.atab th, .apage table.atab td { border: 1px solid #999; padding: 1.5px 3px; }
  .apage table.atab th { font-size: 7pt; background: #eee; }
  .apage table.atab td.num, .apage table.atab th.num { text-align: right; }
  /* A small group travels whole; a big one is allowed to split. */
  .apage tbody.small { break-inside: avoid; }
  .apage tr.ghead td { font-weight: 700; font-size: 8pt; }
  .apage tr.gsub td { font-weight: 700; background: #f4f4f4; border-top: 1px solid #333; }
  .apage tr.gtotal td { font-weight: 700; background: #e9e9e9; border-top: 2px solid #000; }
  .apage tr.gmuted td { color: #666; font-style: italic; }
  .apage span.sw {
    display: inline-block; width: 7px; height: 7px; border-radius: 2px;
    border: 1px solid rgba(0,0,0,0.25); margin-right: 4px; vertical-align: middle;
  }
  .apage span.flag { font-weight: 700; }
  .apage .acell-money { display: flex; justify-content: space-between; gap: 6px; }
`;

/**
 * The printed colour for a flagged lab reading, per HIGHLIGHT_COLORS key.
 *
 * The threshold decision is NOT restated — it comes from `getLabHighlightText`, which
 * is the same function the grid cells and the delivery log call, so a reader who moved
 * their WET limit moves this too. Only the paint has to be translated: the app's
 * palette is Tailwind classes and an iframe with no stylesheet needs a hex. These are
 * the Tailwind 600 shades the on-screen classes resolve to.
 */
const FLAG_HEX: Record<string, string> = {
  red: '#dc2626',
  amber: '#d97706',
  orange: '#ea580c',
  yellow: '#ca8a04',
  blue: '#2563eb',
  purple: '#9333ea',
  pink: '#db2777',
  emerald: '#059669',
};

function flagStyle(
  metric: LabMetric,
  value: number,
  highlights: Record<LabMetric, LabHighlightSpec>,
): string {
  // Empty string = the reading is inside the reader's own limit.
  if (getLabHighlightText(metric, value, highlights) === '') return '';
  const hex = FLAG_HEX[highlights[metric].color] ?? FLAG_HEX.red;
  return ` class="flag" style="color:${hex}"`;
}

/** `₱` pinned left, the number pinned right — the accounting layout, on paper. */
function money(value: number | null, decimals = 2): string {
  if (value === null) return EMDASH;
  return `<span class="acell-money"><span>&#8369;</span><span>${fmtPesoNum(
    value,
    decimals,
  )}</span></span>`;
}

function tint(ramp: LensRampId, index: number, count: number): string {
  return `rgb(${rampRgb(ramp, index, count)} / 0.18)`;
}

function swatch(ramp: LensRampId, index: number, count: number): string {
  return `<span class="sw" style="background: rgb(${rampRgb(ramp, index, count)})"></span>`;
}

interface PrintCol {
  label: string;
  /** Printed column width as a PERCENTAGE of the sheet — `table-layout: fixed`. */
  pct: number;
  num?: boolean;
}

interface PrintGroup {
  word: string;
  range: string;
  index: number;
  count: number;
  ramp: LensRampId;
  /** One array of already-escaped cells per block row. */
  rows: string[][];
  muted?: boolean;
  subtotalLabel: string;
  /** One per column AFTER the two label columns. */
  subtotalCells: string[];
  emptyNote?: string;
}

/** How many rows still count as a SMALL group — see the header note. */
const SMALL_GROUP_ROWS = 4;

function printTable(args: {
  cols: PrintCol[];
  groups: PrintGroup[];
  footerLabel: string;
  footerCells: string[];
}): string {
  const { cols, groups, footerLabel, footerCells } = args;
  const head = cols
    .map((c) => `<th class="${c.num ? 'num' : ''}" style="width:${c.pct}%">${c.label}</th>`)
    .join('');

  const bodies = groups
    .map((g) => {
      const headRow =
        `<tr class="ghead"${g.muted ? '' : ` style="background: ${tint(g.ramp, g.index, g.count)}"`}>` +
        `<td colspan="${cols.length}">${g.muted ? '' : swatch(g.ramp, g.index, g.count)}${escapeHtml(
          g.word,
        )}${g.range ? ` <span style="font-weight:400;color:#444">${escapeHtml(g.range)}</span>` : ''}</td>` +
        `</tr>`;

      const rows =
        g.rows.length === 0
          ? `<tr><td colspan="${cols.length}" style="color:#666;font-style:italic">${escapeHtml(
              g.emptyNote ?? 'No blocks in this group.',
            )}</td></tr>`
          : g.rows
              .map(
                (cells) =>
                  `<tr${g.muted ? ' class="gmuted"' : ''}>` +
                  cells
                    .map((c, i) => `<td class="${cols[i].num ? 'num' : ''}">${c}</td>`)
                    .join('') +
                  `</tr>`,
              )
              .join('');

      const sub =
        `<tr class="gsub">` +
        `<td colspan="2">${escapeHtml(g.subtotalLabel)}</td>` +
        g.subtotalCells
          .map((c, i) => `<td class="${cols[i + 2].num ? 'num' : ''}">${c}</td>`)
          .join('') +
        `</tr>`;

      const small = g.rows.length <= SMALL_GROUP_ROWS ? ' class="small"' : '';
      return `<tbody${small}>${headRow}${rows}${sub}</tbody>`;
    })
    .join('');

  const total =
    `<tbody class="small"><tr class="gtotal">` +
    `<td colspan="2">${escapeHtml(footerLabel)}</td>` +
    footerCells.map((c, i) => `<td class="${cols[i + 2].num ? 'num' : ''}">${c}</td>`).join('') +
    `</tr></tbody>`;

  return `<table class="atab"><thead><tr>${head}</tr></thead>${bodies}${total}</table>`;
}

// ── The muted "no reading" group, shared by every table ─────────────────────

function mutedGroup(
  blocks: readonly BlendAnalysisBlockRef[],
  colCount: number,
  label: string,
): PrintGroup | null {
  if (blocks.length === 0) return null;
  const tailLength = colCount - 3;
  return {
    word: label,
    range: '',
    index: 0,
    count: 1,
    ramp: 'cost',
    muted: true,
    rows: blocks.map((b) => [
      escapeHtml(b.blockLoc),
      escapeHtml(b.batchCode),
      fmtKg(b.kg),
      ...Array.from({ length: tailLength }, () => EMDASH),
    ]),
    subtotalLabel: label,
    subtotalCells: Array.from({ length: colCount - 2 }, () => EMDASH),
  };
}

// ── PRICE ───────────────────────────────────────────────────────────────────

const PRICE_COLS: PrintCol[] = [
  { label: 'Block', pct: 12 },
  { label: 'Batch', pct: 28 },
  { label: 'Balance (kg)', pct: 20, num: true },
  { label: 'PHP/KG', pct: 18, num: true },
  { label: 'Value', pct: 22, num: true },
];

/**
 * ONE ROW's money — a per-ROW product, and the only arithmetic in this file.
 *
 * Every SUBTOTAL and every FOOTER value below is the payload's own `valuePhp`, computed
 * in SQL over the same kilograms. A row multiplying its own two published numbers cannot
 * disagree with a total it does not contribute to; a TypeScript SUM of these rows could.
 */
function blockValuePhp(kg: number, phpKg: number): number {
  return kg * phpKg;
}

function priceRows(blocks: readonly BlendPriceBlock[]): string[][] {
  return blocks.map((b) => [
    escapeHtml(b.blockLoc),
    escapeHtml(b.batchCode),
    fmtKg(b.kg),
    money(b.phpKg),
    money(blockValuePhp(b.kg, b.phpKg), 0),
  ]);
}

function pricePage(analysis: BlendAnalysis, priceBandNames: Record<string, string>): string {
  const price = analysis.price;
  if (!price) return '';

  // ── (a) Natural breaks ──
  const nat = price.natural;
  const groups: PrintGroup[] = [...nat.groups]
    .sort((a, b) => b.index - a.index)
    .map((g) => ({
      word: groupWord(g.label, nat.groupCount),
      range: `${fmtPeso(g.rangeMin)} – ${fmtPeso(g.rangeMax)}`,
      index: g.index,
      count: nat.groupCount,
      ramp: 'cost' as LensRampId,
      rows: priceRows(g.blocks),
      subtotalLabel: `${groupWord(g.label, nat.groupCount)} subtotal · ${blocksWord(
        g.blockCount,
      )} · ${fmtSharePct(g.kgSharePct)} of kg`,
      subtotalCells: [
        `${fmtKg(g.kg)} kg`,
        money(g.kgWeightedPhpKg),
        money(g.valuePhp, 0),
      ],
    }));
  const noPrice = mutedGroup(nat.unmeasured.blocks, PRICE_COLS.length, 'No price');
  if (noPrice) groups.push(noPrice);

  const o = nat.overall;
  const naturalTable = printTable({
    cols: PRICE_COLS,
    groups,
    footerLabel: `Whole blend · ${blocksWord(o.blockCount)}`,
    footerCells: [`${fmtKg(o.kg)} kg`, money(o.kgWeightedPhpKg), money(o.valuePhp, 0)],
  });

  const gapNote =
    o.equalsSnapshot === false && o.snapshotPhpKg !== null && o.kgWeightedPhpKg !== null
      ? snapshotGapNote({
          snapshot: fmtPeso(o.snapshotPhpKg),
          measured: fmtPeso(o.kgWeightedPhpKg),
          excluded: 'unpriced blocks',
        })
      : nat.unmeasured.blockCount > 0
        ? unmeasuredNote(nat.unmeasured, 'price yet')
        : '';

  // ── (b) Against market ──
  let marketSection: string;
  const vm = price.vsMarket;
  if (!vm) {
    marketSection = `<p class="anote">${escapeHtml(
      price.vsMarketUnavailable
        ? vsMarketUnavailableNote(price.vsMarketUnavailable)
        : 'No market comparison is available for this blend.',
    )}</p>`;
  } else {
    const bands: PrintGroup[] = [...vm.bands]
      .sort((a, b) => b.index - a.index)
      .map((b) => ({
        word: priceBandLabel(b, vm.roundedUpPhp, priceBandNames),
        // The lens's label already states the bounds — see the screen's note.
        range: '',
        index: b.index,
        count: vm.bands.length,
        ramp: 'cost' as LensRampId,
        rows: priceRows(b.blocks),
        subtotalLabel: `Band subtotal · ${blocksWord(b.blockCount)} · ${fmtSharePct(
          b.kgSharePct,
        )} of kg`,
        subtotalCells: [`${fmtKg(b.kg)} kg`, money(b.kgWeightedPhpKg), money(b.valuePhp, 0)],
        emptyNote: 'No block in this blend is in this band.',
      }));
    const vmNoPrice = mutedGroup(vm.unmeasured.blocks, PRICE_COLS.length, 'No price');
    if (vmNoPrice) bands.push(vmNoPrice);

    marketSection =
      `<p class="anote">${escapeHtml(`${vsMarketCaption(vm)} Dearest band first.`)}</p>` +
      printTable({
        cols: PRICE_COLS,
        groups: bands,
        footerLabel: `Whole blend · ${blocksWord(vm.overall.blockCount)}`,
        footerCells: [
          `${fmtKg(vm.overall.kg)} kg`,
          money(vm.overall.kgWeightedPhpKg),
          money(vm.overall.valuePhp, 0),
        ],
      });
  }

  return `
<section class="apage">
  <h2>Price groups — natural breaks</h2>
  <p class="anote">${escapeHtml(
    naturalMethodNote({
      subject: 'prices',
      groupCount: nat.groupCount,
      cuts: nat.cuts,
      gvf: nat.gvf,
      formatCut: (v) => fmtPeso(v),
    }),
  )} High → average → low; dearest block first inside each group.</p>
  ${naturalTable}
  ${gapNote ? `<p class="afoot-note">${escapeHtml(gapNote)}</p>` : ''}
  <h3>Against market</h3>
  ${marketSection}
</section>`;
}

// ── QUALITY ─────────────────────────────────────────────────────────────────

const QUALITY_TABLES: { metric: BlendQualityMetric; companion?: BlendQualityMetric }[] = [
  { metric: 'mc' },
  { metric: 'ash' },
  { metric: 'bd_astm', companion: 'bd_jis' },
];

function qualityCols(companion?: BlendQualityMetric): PrintCol[] {
  const cols: PrintCol[] = [
    { label: 'Block', pct: companion ? 12 : 14 },
    { label: 'Batch', pct: companion ? 28 : 32 },
    { label: 'Balance (kg)', pct: companion ? 24 : 28, num: true },
    { label: 'Reading', pct: companion ? 18 : 26, num: true },
  ];
  if (companion) cols.push({ label: QUALITY_METRIC_LABELS[companion], pct: 18, num: true });
  return cols;
}

function qualityPage(
  analysis: BlendAnalysis,
  labHighlights: Record<LabMetric, LabHighlightSpec>,
): string {
  const blocks = QUALITY_TABLES.map(({ metric, companion }) => {
    const nat = analysis.quality.byMetric[metric];
    const comp = companion ? analysis.quality.byMetric[companion] : null;
    const cols = qualityCols(companion);

    // The companion's per-block reading, by block. A LOOKUP, not a computation.
    const compByBlock = new Map<string, number>();
    if (comp) for (const g of comp.groups) for (const b of g.blocks) compByBlock.set(b.blockLoc, b.value);

    const groups: PrintGroup[] = [...nat.groups]
      .sort((a, b) => b.index - a.index)
      .map((g) => ({
        word: groupWord(g.label, nat.groupCount),
        range: `${fmtQuality(metric, g.rangeMin)} – ${fmtQuality(metric, g.rangeMax)}`,
        index: g.index,
        count: nat.groupCount,
        // Quality is not cost — a wet block painted red would read as an expensive one.
        ramp: 'age' as LensRampId,
        rows: g.blocks.map((b) => {
          const cells = [
            escapeHtml(b.blockLoc),
            escapeHtml(b.batchCode),
            fmtKg(b.kg),
            `<span${flagStyle(metric, b.value, labHighlights)}>${fmtQuality(metric, b.value)}</span>`,
          ];
          if (companion) {
            const cv = compByBlock.get(b.blockLoc);
            cells.push(
              cv === undefined
                ? EMDASH
                : `<span${flagStyle(companion, cv, labHighlights)}>${fmtQuality(companion, cv)}</span>`,
            );
          }
          return cells;
        }),
        subtotalLabel: `${groupWord(g.label, nat.groupCount)} subtotal · ${blocksWord(
          g.blockCount,
        )} · ${fmtSharePct(g.kgSharePct)} of kg`,
        subtotalCells: companion
          ? [`${fmtKg(g.kg)} kg`, fmtQuality(metric, g.kgWeightedValue), EMDASH]
          : [`${fmtKg(g.kg)} kg`, fmtQuality(metric, g.kgWeightedValue)],
      }));

    const noReading = mutedGroup(nat.unmeasured.blocks, cols.length, 'No reading');
    if (noReading) groups.push(noReading);

    const o = nat.overall;
    const table = printTable({
      cols,
      groups,
      footerLabel: `Whole blend · ${blocksWord(o.blockCount)}`,
      footerCells:
        companion && comp
          ? [
              `${fmtKg(o.kg)} kg`,
              fmtQuality(metric, o.kgWeightedValue),
              fmtQuality(companion, comp.overall.kgWeightedValue),
            ]
          : [`${fmtKg(o.kg)} kg`, fmtQuality(metric, o.kgWeightedValue)],
    });

    const gapNote =
      o.equalsSnapshot === false && o.snapshotValue !== null && o.kgWeightedValue !== null
        ? snapshotGapNote({
            snapshot: fmtQuality(metric, o.snapshotValue),
            measured: fmtQuality(metric, o.kgWeightedValue),
            excluded: 'blocks with no reading',
          })
        : nat.unmeasured.blockCount > 0
          ? unmeasuredNote(nat.unmeasured, 'reading')
          : '';

    const heading = `${QUALITY_METRIC_LABELS[metric]}${
      companion ? ` + ${QUALITY_METRIC_LABELS[companion]}` : ''
    } · ${QUALITY_METRIC_UNITS[metric]}`;

    return `
  <h3>${escapeHtml(heading)}</h3>
  <p class="anote">${escapeHtml(
    naturalMethodNote({
      subject: `${QUALITY_METRIC_LABELS[metric]} readings`,
      groupCount: nat.groupCount,
      cuts: nat.cuts,
      gvf: nat.gvf,
      formatCut: (v) => v.toFixed(qualityDecimals(metric)),
    }),
  )}</p>
  ${table}
  ${gapNote ? `<p class="afoot-note">${escapeHtml(gapNote)}</p>` : ''}`;
  }).join('');

  return `
<section class="apage">
  <h2>Quality — MC · ASH · BD</h2>
  <p class="anote">Highest reading first. A reading past your own WET / ASHY limit is
  coloured, exactly as it is on the grid. BD JIS rides beside BD ASTM rather than in a
  fourth table — its group averages are cut in different places, so only the blend's
  own weighted JIS is shown, in the footer.</p>
  ${blocks}
</section>`;
}

// ── AGE ─────────────────────────────────────────────────────────────────────

const AGE_COLS: PrintCol[] = [
  { label: 'Block', pct: 11 },
  { label: 'Batch', pct: 25 },
  { label: 'Balance (kg)', pct: 18, num: true },
  { label: 'Age (d)', pct: 12, num: true },
  { label: 'First delivery', pct: 17, num: true },
  { label: 'Last delivery', pct: 17, num: true },
];

function agePage(analysis: BlendAnalysis, ageBandNames: Record<string, string>): string {
  const age = analysis.age;
  const groups: PrintGroup[] = [...age.bands]
    .sort((a, b) => b.index - a.index)
    .map((b: BlendAgeBand) => ({
      word: ageBandLabel(b, ageBandNames),
      range:
        b.upperDays === null
          ? `${b.lowerDays.toLocaleString()} d and over`
          : `${b.lowerDays.toLocaleString()}–${b.upperDays.toLocaleString()} d`,
      index: b.index,
      count: age.bands.length,
      ramp: 'age' as LensRampId,
      rows: b.blocks.map((blk) => [
        escapeHtml(blk.blockLoc),
        escapeHtml(blk.batchCode),
        fmtKg(blk.kg),
        fmtDays(blk.ageDays),
        escapeHtml(blk.firstDeliveryDate ?? EMDASH),
        escapeHtml(blk.lastDeliveryDate ?? EMDASH),
      ]),
      subtotalLabel: `Band subtotal · ${blocksWord(b.blockCount)} · ${fmtSharePct(
        b.kgSharePct,
      )} of kg`,
      subtotalCells: [`${fmtKg(b.kg)} kg`, fmtDays(b.kgWeightedAgeDays), EMDASH, EMDASH],
      emptyNote: 'No block in this blend is in this band.',
    }));

  const undated = mutedGroup(age.undated.blocks, AGE_COLS.length, 'No delivery dates');
  if (undated) groups.push(undated);

  const o = age.overall;
  const caption =
    `Ages as of ${age.asOf}, weighted by the kilograms still in each pile, from its ` +
    `deliveries’ average date. Oldest band first.` +
    (o.oldestAgeDays !== null
      ? ` Oldest pile ${fmtWholeDays(o.oldestAgeDays)}${
          o.oldestBlockLoc ? ` at ${o.oldestBlockLoc}` : ''
        }${o.oldestBatchCode ? ` (${o.oldestBatchCode})` : ''}.`
      : '');

  const undatedNote =
    age.undated.blockCount > 0
      ? `${blocksWord(age.undated.blockCount)}, ${fmtKg(age.undated.kg)} kg, have no delivery at or before ${
          age.asOf
        } — they have no age, which is not the same as being new. In no band and out of every average.`
      : '';

  return `
<section class="apage">
  <h2>Age</h2>
  <p class="anote">${escapeHtml(caption)}</p>
  ${printTable({
    cols: AGE_COLS,
    groups,
    footerLabel: `Whole blend · ${blocksWord(o.blockCount)}`,
    footerCells: [`${fmtKg(o.kg)} kg`, fmtDays(o.kgWeightedAgeDays), EMDASH, EMDASH],
  })}
  ${undatedNote ? `<p class="afoot-note">${escapeHtml(undatedNote)}</p>` : ''}
</section>`;
}

// ── The public builder ──────────────────────────────────────────────────────

export interface BlendAnalysisPrintInput {
  analysis: BlendAnalysis | null;
  options: BlendAnalysisOptions;
  /** The EFFECTIVE price flag (server gate AND the page's Prices toggle). */
  canViewPrices: boolean;
  priceBandNames?: Record<string, string>;
  ageBandNames?: Record<string, string>;
  labHighlights: Record<LabMetric, LabHighlightSpec>;
}

/**
 * The chosen analysis sheets, as HTML — or `''` when there are none, or when the
 * payload has not arrived.
 *
 * A PRICE-DENIED print carries no price page at all: `analysisPages` drops it on the
 * flag, and the payload itself arrives with `price: null` and `pricesHidden: true`, so
 * there are two independent reasons a ₱ cannot reach the paper.
 */
export function buildBlendAnalysisPages(input: BlendAnalysisPrintInput): string {
  const { analysis, options, canViewPrices, labHighlights } = input;
  if (!analysis) return '';
  const pages = analysisPages(options, canViewPrices);
  if (pages.length === 0) return '';

  const out: string[] = [];
  for (const id of pages) {
    if (id === 'price') out.push(pricePage(analysis, input.priceBandNames ?? {}));
    if (id === 'quality') out.push(qualityPage(analysis, labHighlights));
    if (id === 'age') out.push(agePage(analysis, input.ageBandNames ?? {}));
  }
  return out.filter((s) => s !== '').join('\n');
}

/** How many analysis SHEETS the printout will carry — for the button's own label. */
export function blendAnalysisPageCount(
  options: BlendAnalysisOptions,
  canViewPrices: boolean,
): number {
  return analysisPages(options, canViewPrices).length;
}

/** Re-exported so a caller does not have to know which module owns the unmeasured shape. */
export type { BlendAnalysisUnmeasured };
