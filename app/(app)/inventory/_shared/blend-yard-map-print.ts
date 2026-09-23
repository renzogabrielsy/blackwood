// ─────────────────────────────────────────────────────────────────────────────
// THE BLEND PROPOSAL'S YARD MAP — where the blend sits, on ONE landscape sheet.
//
// The owner: *"I'd also like to see a blocking view in the print of blend proposals,
// similar to the ones we made for the lens prints."*
//
// ── IT IS THE LENS MAP. NOT A PORT OF IT ────────────────────────────────────
// The geometry (`WAREHOUSES` via `buildYardMapCells`), the one-page fit
// (`solveYardMapFit`), the paper palette (`LENS_PRINT_FILL_RGB` through
// `printFillRgbAtStop`), the ink rule (`lensYardMapInkOn`) and the four cell kinds
// (`lensYardMapPaint`) are all IMPORTED from `blocking/lens/lens-yard-map-model.ts`.
// This file adds two things and nothing else: the HTML the blend's iframe printout needs
// (the lens sheet is a React component laying out in the live DOM, and the blend printout
// is a self-contained document — neither can render the other), and the decision of WHICH
// BAND each block is in.
//
// ── THE COLOUR RULE, IN ONE SENTENCE EACH ───────────────────────────────────
//   • A SELECTED block is filled SOLID. With the PRICE GROUPS page on and its payload
//     present, by the proposal's own natural-breaks group (low / average / high → the cost
//     ramp's stops 0 / 3 / 6, exactly the mapping the analysis tables use, resolved by the
//     same `resolveBandRampStop`). Otherwise ONE accent — the cost ramp's MIDDLE stop —
//     with the legend saying only `Selected block`.
//   • Every OTHER occupied slot is the light neutral grey with its loc small and dark.
//   • An EMPTY slot is white with a hairline and a small muted loc.
//   • A selected block the yard NO LONGER HOLDS keeps its selection fill and takes a
//     dashed inset outline, and the legend names it. It is never dropped.
//
// ── IT COMPUTES NOTHING ─────────────────────────────────────────────────────
// No kilogram, no ₱, no age, no lab reading, no share. Group membership is read off
// `analysis.price.natural.groups[].blocks[]`; the words come from `blend-analysis-text.ts`.
// **There is no ₱ anywhere on this sheet**, which is why the Include-pages checkbox for it
// is NOT price-gated: a price-denied reader gets the map, in the single accent.
// ─────────────────────────────────────────────────────────────────────────────

import { groupWord } from './blend-analysis-text';
import { escapeHtml } from './print-utils';
import { printFillRgbAtStop, resolveBandRampStop } from '../blocking/lens/lens-ramp';
import {
  BLEND_YARD_MAP_ACCENT_STOP,
  BLEND_YARD_MAP_SELECTED_BAND,
  LENS_YARD_MAP_EMPTY_BG,
  LENS_YARD_MAP_EMPTY_INK,
  LENS_YARD_MAP_HAIRLINE,
  LENS_YARD_MAP_MUTED_BG,
  LENS_YARD_MAP_MUTED_INK,
  YARD_MAP_COLHDR_H_PX,
  YARD_MAP_GUTTER_PX,
  YARD_MAP_LABEL_H_PX,
  YARD_MAP_LANE_GAP_PX,
  YARD_MAP_SECTION_GAP_PX,
  buildBlendYardMapCells,
  lensYardMapInkOn,
  lensYardMapLines,
  lensYardMapPaint,
  solveYardMapFit,
  type LensYardMap,
  type LensYardMapBand,
  type YardMapFit,
} from '../blocking/lens/lens-yard-map-model';
import type { BlendAnalysis } from '../blocking/types';

/**
 * The blend printout's page margin.
 *
 * ONE constant, read by the document's own `@page` rule AND by the map's fit arithmetic,
 * for the reason `LENS_PRINT_MARGIN_MM` exists on the lens sheet: the two are the same
 * number stated twice and a sheet that solves against a different box than it prints on
 * has no one-page promise at all.
 */
export const BLEND_PRINT_MARGIN_MM = 10;

/** The map's colour ramp. Ordinal, because low → average → high is an ordering. */
const BLEND_YARD_MAP_RAMP = 'cost' as const;

// ── THE HEIGHT THIS SHEET SPENDS ON THINGS THAT ARE NOT CELLS ───────────────
//
// ⚠️ MEASURED, AND IT IS WHY THE FIRST DRAFT SPILLED. The lens map reserves 40 px for its
// heading and legend; this sheet also carries an as-of caption and a footnote line, and at
// 40 px it laid out **764.70 px against 718.11 px of printable height (46.59 px over)** —
// which Chrome cannot fix with `break-inside: avoid`, so the legend printed on a second
// sheet. Measured in a real print-media render of the emitted document:
//
//   the `<h2>` line   19.80 px + 1 px margin   → 21
//   the legend line   14.00 px + 3 px margin   → 17
//   a footnote line   14.00 px per line        → budgeted at TWO, so a long block list
//                                                that wraps cannot push the page over
//
// The CAPTION rides ON the heading line and both footnotes join into ONE line, which is
// what keeps the cells near the lens map's size: budgeting them separately cost 5.5 px per
// cell row (33.65 px cells with PCA/PCB in, against 37.0 px folded).

const BLEND_YARD_MAP_HEADING_PX = 21;
const BLEND_YARD_MAP_LEGEND_PX = 17;
/** One footnote LINE. The note is budgeted at two, because it can wrap. */
const BLEND_YARD_MAP_NOTE_LINE_PX = 14;
/** Sub-pixel rounding across four measured boxes. */
const BLEND_YARD_MAP_SLACK_PX = 4;

/** What the sheet will spend above and below the grid, given what it will actually say. */
function blendYardMapReservedPx(hasNote: boolean): number {
  return (
    BLEND_YARD_MAP_HEADING_PX +
    BLEND_YARD_MAP_LEGEND_PX +
    (hasNote ? 2 * BLEND_YARD_MAP_NOTE_LINE_PX : 0) +
    BLEND_YARD_MAP_SLACK_PX
  );
}

export interface BlendYardMapInput {
  /** Every `block_loc` the yard holds a pile in RIGHT NOW — the grid's own payload. */
  occupiedLocs: readonly string[];
  /** The proposal's blocks, by `block_loc`. */
  selectedLocs: readonly string[];
  /** The analysis payload, or null while it has not arrived. */
  analysis: BlendAnalysis | null;
  /**
   * Is the PRICE GROUPS page ON for this reader? (`analysisPages(...)` includes `price`.)
   *
   * It is asked rather than inferred from the payload, because the payload's `price`
   * section can be present while the reader has the page switched off — and a map coloured
   * by a grouping the document does not explain would be a legend with no table.
   */
  priceGroupsOn: boolean;
  /**
   * `yyyy-MM-dd` of the SAVED version's own snapshot, when this is a saved version.
   *
   * It drives the caption, and the caption is the honest part of this page: the yard's
   * OCCUPANCY is today's (it comes from the live grid payload) while the SELECTION is the
   * day it was proposed. Saying so is the only way a reader can trust a map of a
   * three-week-old blend.
   */
  asSavedDate?: string | null;
}

export interface BlendYardMapModel {
  map: LensYardMap;
  /** The bands the sheet shows, lowest first. */
  bands: readonly LensYardMapBand[];
  bandCount: number;
  ramp: typeof BLEND_YARD_MAP_RAMP;
  /** Selected blocks the yard no longer holds. Dashed, and named. */
  goneLocs: readonly string[];
  /** TRUE when the fill is the price groups rather than the single accent. */
  byPriceGroup: boolean;
  /** `Yard occupancy as of today · selection as saved 2026-09-21` */
  caption: string;
  /**
   * The whole heading line, `<fact> · <fact>` in the house style — the slot count, the
   * caption and what the page is for. It rides ON the `<h2>` rather than under it because
   * a separate caption line cost 5.5 px off every cell row (see the chrome budget above).
   */
  headline: string;
  /**
   * The ONE footnote, or ''. Both statements the map cannot draw — a selected block the
   * yard no longer holds, and a block code that is not a slot on this layout — joined
   * into a single line, for the same height reason.
   */
  note: string;
}

/**
 * Normalize the map once, for BOTH print paths.
 *
 * The HTML sheet and the jsPDF page consume exactly this object, so they cannot describe
 * different yards, different bands or different captions.
 */
export function buildBlendYardMapModel(input: BlendYardMapInput): BlendYardMapModel {
  const { occupiedLocs, selectedLocs, analysis, priceGroupsOn, asSavedDate } = input;

  const natural = priceGroupsOn ? analysis?.price?.natural ?? null : null;

  // `block_loc` → the group the PAYLOAD puts it in. A LOOKUP; nothing is grouped here.
  let groupByLoc: Record<string, number> | undefined;
  let bands: LensYardMapBand[];
  let bandCount: number;
  if (natural && natural.groups.length > 0) {
    groupByLoc = {};
    for (const g of natural.groups) {
      for (const b of g.blocks) groupByLoc[b.blockLoc] = g.index;
    }
    bands = [...natural.groups]
      // LOWEST first — the legend reads low → average → high, the direction a reader
      // scans. (The analysis TABLES lead with the dearest group; that is their own
      // ordering decision and neither is derived from the other.)
      .sort((a, b) => a.index - b.index)
      .map((g) => ({ index: g.index, label: groupWord(g.label, natural.groupCount) }));
    bandCount = natural.groupCount;
  } else {
    bands = [
      {
        index: BLEND_YARD_MAP_SELECTED_BAND,
        label: 'Selected block',
        rampStop: BLEND_YARD_MAP_ACCENT_STOP,
      },
    ];
    bandCount = 1;
  }

  const { map, goneLocs } = buildBlendYardMapCells({
    occupiedLocs,
    selectedLocs,
    groupByLoc,
  });

  const caption = asSavedDate
    ? `Yard occupancy as of today · selection as saved ${asSavedDate}`
    : 'Yard occupancy as of today';

  // Two things the map CANNOT draw, said rather than hidden — the lens map's discipline,
  // folded onto one line so it costs one budgeted footnote rather than two.
  const noteParts: string[] = [];
  if (goneLocs.length > 0) {
    noteParts.push(
      `No longer occupied (${goneLocs.length}): ${goneLocs.join(' · ')} — in this blend, ` +
        'nothing in the yard there today',
    );
  }
  if (map.offMapLocs.length > 0) {
    noteParts.push(
      `Not on the map (${map.offMapLocs.length}): ${map.offMapLocs.join(' · ')} — not a ` +
        'slot on this warehouse layout',
    );
  }

  return {
    map,
    bands,
    bandCount,
    ramp: BLEND_YARD_MAP_RAMP,
    goneLocs,
    byPriceGroup: groupByLoc !== undefined,
    caption,
    headline: `${selectedLocs.length} of ${map.slotCount} slots in this blend · ${caption} · location reference only`,
    note: noteParts.join(' · '),
  };
}

/** The stop each shown band wears — ONE resolver, shared with the lens map. */
export function blendYardMapStops(model: BlendYardMapModel): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of model.bands) {
    out.set(b.index, resolveBandRampStop(model.ramp, b.index, model.bandCount, b.rampStop));
  }
  return out;
}

/**
 * The solve for a given page margin, with THIS sheet's own chrome budget.
 *
 * Exported with the margin as an argument because the two documents print at different
 * ones — the HTML sheet at `BLEND_PRINT_MARGIN_MM`, the jsPDF file at its own 40 pt — and
 * the budget is the part that must not be restated.
 */
export function blendYardMapSolve(model: BlendYardMapModel, marginMm: number): YardMapFit {
  return solveYardMapFit(model.map, marginMm, blendYardMapReservedPx(model.note !== ''));
}

/** The solve, against the blend document's OWN margin and its OWN chrome budget. */
export function blendYardMapFit(model: BlendYardMapModel): YardMapFit {
  return blendYardMapSolve(model, BLEND_PRINT_MARGIN_MM);
}

/** One legend row. `dashed` draws the swatch's own border dashed, never a second colour. */
export interface BlendYardMapLegendRow {
  bg: string;
  border: string;
  text: string;
  dashed?: boolean;
}

/**
 * The legend — built once so the HTML sheet and the PDF page cannot describe the map
 * differently.
 */
export function blendYardMapLegend(model: BlendYardMapModel): BlendYardMapLegendRow[] {
  const stops = blendYardMapStops(model);
  const rows: BlendYardMapLegendRow[] = model.bands.map((b) => {
    const rgb = printFillRgbAtStop(model.ramp, stops.get(b.index) ?? 0);
    return { bg: `rgb(${rgb})`, border: lensYardMapInkOn(rgb), text: b.label };
  });
  if (model.goneLocs.length > 0) {
    // The marker, not a fill: those cells wear the SELECTION colour and a dashed outline,
    // so the swatch is DASHED too — a solid box beside the word "dashed" explains nothing.
    rows.push({
      bg: LENS_YARD_MAP_EMPTY_BG,
      border: LENS_YARD_MAP_MUTED_INK,
      text: `dashed = no longer occupied (${model.goneLocs.length})`,
      dashed: true,
    });
  }
  rows.push({
    bg: LENS_YARD_MAP_MUTED_BG,
    border: LENS_YARD_MAP_MUTED_INK,
    text: 'other block in the yard',
  });
  rows.push({ bg: LENS_YARD_MAP_EMPTY_BG, border: LENS_YARD_MAP_EMPTY_INK, text: 'empty slot' });
  return rows;
}

// ── The HTML sheet ──────────────────────────────────────────────────────────
//
// Scoped to `.ymap` so it cannot reach the rest of the printout, and carrying its OWN
// `break-before: page` rather than borrowing `.apage`'s — the analysis stylesheet rides
// only when there ARE analysis sheets, and the map must page correctly when it is the
// only extra sheet a reader asked for.

export const BLEND_YARD_MAP_PRINT_CSS = `
  /* ONE LANDSCAPE PAGE, structurally: it starts a sheet and may not split across two. */
  .ymap { break-before: page; page-break-before: always; break-inside: avoid; page-break-inside: avoid; }
  .ymap h2 {
    font-size: 12px; margin: 0 0 1px; padding-bottom: 2px;
    border-bottom: 1px solid #000; text-transform: uppercase; letter-spacing: 0.04em;
    break-after: avoid;
  }
  .ymap h2 span { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 9pt; color: #52525b; }
  .ymap .ylane { display: flex; align-items: flex-start; }
  .ymap .ywhse { font-size: 7pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #52525b; }
  .ymap .ygrid { display: grid; }
  .ymap .ycol { display: flex; align-items: flex-end; justify-content: center; font-size: 5.5pt; line-height: 1; color: #71717a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .ymap .yrow { display: flex; align-items: center; justify-content: center; font-size: 6.5pt; font-weight: 600; color: #71717a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .ymap .ycell {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    overflow: hidden; text-align: center; box-sizing: border-box;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700; line-height: 1;
    border: 1px solid ${LENS_YARD_MAP_HAIRLINE};
  }
  .ymap .yleg { display: flex; flex-wrap: wrap; align-items: center; gap: 1px 10px; font-size: 7.5pt; color: #3f3f46; margin: 3px 0 0; }
  .ymap .yleg span.sw { display: inline-block; width: 7px; height: 7px; border-radius: 1px; margin-right: 4px; vertical-align: middle; }
  .ymap .ynote { font-size: 7.5pt; color: #52525b; margin: 1px 0 0; }
`;

/**
 * The whole sheet, as one `<section class="ymap">`.
 *
 * Every size comes out of the shared solve; nothing here is a hand-tuned pixel.
 */
export function buildBlendYardMapPage(model: BlendYardMapModel): string {
  const { map } = model;
  const fit = blendYardMapFit(model);
  const stops = blendYardMapStops(model);
  const cellPx = fit.cells.cellPx;

  const lanes = [...new Set(map.sections.map((s) => s.lane))].sort((a, b) => a - b);

  const cellHtml = (sectionKey: string, cell: (typeof map.sections)[number]['cells'][number][number]) => {
    const paint = lensYardMapPaint(cell, model.ramp, stops);
    const lines = fit.wrapAll ? lensYardMapLines(sectionKey, cell.loc, true) : cell.lines;
    // An EMPTY slot's loc is deliberately smaller and lighter — it is still a location
    // reference, but a slot with nothing in it must not read as loudly as a pile.
    const pt = paint.kind === 'empty' ? Math.min(fit.fontPt, 7.5) : fit.fontPt;
    const outline = paint.outline
      ? `outline:1px dashed ${paint.outline};outline-offset:-2px;`
      : '';
    return (
      `<div class="ycell" style="width:${cellPx}px;height:${cellPx}px;` +
      `background:${paint.bg};color:${paint.ink};font-size:${pt}pt;` +
      `font-weight:${paint.kind === 'empty' ? 400 : 700};${outline}">` +
      lines.map((l) => `<span>${escapeHtml(l)}</span>`).join('') +
      `</div>`
    );
  };

  const laneHtml = lanes
    .map((lane, laneIdx) => {
      const sections = map.sections.filter((s) => s.lane === lane);
      const inner = sections
        .map((s) => {
          const header =
            `<div class="ywhse" style="height:${YARD_MAP_LABEL_H_PX}px;line-height:${YARD_MAP_LABEL_H_PX}px">${escapeHtml(
              s.label,
            )}</div>`;
          const cols = s.cols
            .map((c) => `<div class="ycol">${c}</div>`)
            .join('');
          const rows = s.rows
            .map(
              (row, ri) =>
                `<div class="yrow">${escapeHtml(row)}</div>` +
                s.cells[ri].map((cell) => cellHtml(s.key, cell)).join(''),
            )
            .join('');
          return (
            `<div>${header}` +
            `<div class="ygrid" style="grid-template-columns:${YARD_MAP_GUTTER_PX}px repeat(${s.cols.length}, ${cellPx}px);` +
            `grid-template-rows:${YARD_MAP_COLHDR_H_PX}px repeat(${s.rows.length}, ${cellPx}px)">` +
            `<div></div>${cols}${rows}` +
            `</div></div>`
          );
        })
        .join('');
      return (
        `<div class="ylane" style="gap:${YARD_MAP_SECTION_GAP_PX}px;` +
        `margin-top:${laneIdx === 0 ? 0 : YARD_MAP_LANE_GAP_PX}px">${inner}</div>`
      );
    })
    .join('');

  const legend = blendYardMapLegend(model)
    .map(
      (r) =>
        `<span><span class="sw" style="background:${r.bg};border:1px ${
          r.dashed ? 'dashed' : 'solid'
        } ${r.border}"></span>${escapeHtml(r.text)}</span>`,
    )
    .join('');

  // The ONE footnote (see the model), plus the solve's own refusal if it ever fails. Both
  // are BUDGETED lines — see the chrome budget at the top of this file.
  const note = model.note === '' ? '' : `<p class="ynote">${escapeHtml(model.note)}</p>`;
  const doesNotFit = !fit.cells.fits
    ? `<p class="ynote"><strong>The yard does not fit this sheet at a legible size — ${map.slotCount} slots over ${fit.cells.cellRowCount} rows.</strong></p>`
    : '';

  return `
<section class="ymap">
  <h2>Yard map <span>${escapeHtml(model.headline)}</span></h2>
  <div style="width:${fit.cells.totalWidthPx}px">${laneHtml}</div>
  <p class="yleg">${legend}</p>
  ${note}${doesNotFit}
</section>`;
}
