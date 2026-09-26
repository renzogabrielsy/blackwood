/**
 * Vector (text-based) PDF generation for the Blend Proposal modal.
 *
 * Uses jsPDF + jspdf-autotable to produce a crisp, SELECTABLE-text PDF — NOT a
 * rasterized DOM screenshot. The document is built directly from the structured
 * `proposal` payload (the same data the on-screen modal and `buildBlendPrintDocument`
 * use), so it never depends on the live DOM, dark mode, Tailwind, or fixed positioning.
 *
 * Price gating mirrors the print/on-screen rule EXACTLY: per-block PHP/KG column, raw
 * price, product cost, and the whole pricing block are emitted ONLY when
 * `proposal.can_view_prices` is true AND the value is non-null. The per-block lab columns
 * are NOT gated. No role lookup here — relies solely on the payload flag + null checks.
 *
 * Currency note: jsPDF's built-in Helvetica is WinAnsi-encoded and does NOT contain the
 * peso glyph `₱` (U+20B1) — it mis-maps to `±`. To keep the PDF text crisp/selectable
 * without embedding a Unicode font, the PDF spells currency as a `PHP ` prefix (e.g.
 * `PHP 42.00`). The on-screen modal + HTML print still use the `₱` glyph (they render in
 * the browser, where the glyph is fine).
 */

import { jsPDF, GState } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { BlendProposal } from '../blocking/actions';
import type {
  BlendAnalysis,
  BlendBlockFacts,
  BlendQualityMetric,
} from '../blocking/types';
// PERF-4: the pure filename helpers live in a jspdf-free module so callers can import
// them WITHOUT pulling jsPDF into the bundle. Re-exported here for back-compat + the
// node/test path.
import { sanitizeLabel, composeBlendPdfFilename } from './blend-proposal-filename';
import { blendVersionLine, type BlendDocMeta } from './print-utils';
import { analysisPages, type BlendAnalysisOptions } from './blend-analysis-options';
import {
  ageMethodNote,
  blocksWord,
  fmtDays,
  fmtQuality,
  fmtSharePct,
  groupWord,
  naturalMethodNote,
  QUALITY_METRIC_LABELS,
  QUALITY_METRIC_UNITS,
  undatedNote,
  unmeasuredNote,
  vsMarketCaption,
  vsMarketHeading,
  vsMarketUnavailableNote,
} from './blend-analysis-text';
import { rampRgb } from '../blocking/lens/lens-ramp';
// THE YARD MAP (2026-09-23) — the SAME model the HTML printout draws, the SAME solve and
// the SAME paper palette the lens print uses. Nothing here re-derives the geometry.
import {
  blendYardMapLegend,
  blendYardMapSolve,
  blendYardMapStops,
  type BlendYardMapModel,
} from './blend-yard-map-print';
import {
  LENS_YARD_MAP_HAIRLINE,
  YARD_MAP_COLHDR_H_PX,
  YARD_MAP_GUTTER_PX,
  YARD_MAP_LABEL_H_PX,
  YARD_MAP_LANE_GAP_PX,
  YARD_MAP_SECTION_GAP_PX,
  lensYardMapLines,
  lensYardMapPaint,
} from '../blocking/lens/lens-yard-map-model';
// PAGE ONE'S MARKET CHART (2026-09-26) — the SAME model + geometry the HTML printout draws.
import {
  BLEND_MARKET_AREA_OPACITY,
  BLEND_MARKET_CHART_TITLE,
  BLEND_MARKET_INK,
  BLEND_MARKET_UNAVAILABLE_HEADLINE,
  layoutBlendMarketChart,
  type BlendMarketChartSlot,
} from './blend-market-chart';
import { ageBandLabel } from '../blocking/lens/age-lens-settings';
import { priceBandLabel } from '../blocking/lens/price-lens-settings';
import type { LabHighlightSpec, LabMetric } from '@/types/table-settings';

export { sanitizeLabel, composeBlendPdfFilename };

// ─── Formatting helpers (match the modal/print precision) ─────────────────────

/** BD → 3 decimals, the rest → 2 (same as the modal + print doc). */
function fmtLab(key: string, value: number): string {
  return key === 'bd_astm' || key === 'bd_jis' ? value.toFixed(3) : value.toFixed(2);
}

function fmtKg(val: number): string {
  return Math.round(val).toLocaleString();
}

/** `PHP 42.00` — PDF-safe currency (no `₱` glyph; see file header). */
function fmtPhp(n: number): string {
  return `PHP ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Lab columns in canonical order — keys index `BlendProposalBlock` + `weighted`. */
const LAB_KEYS: { key: keyof BlendProposal['weighted']; label: string }[] = [
  { key: 'mc', label: 'MC' },
  { key: 'ash', label: 'ASH' },
  { key: 'bd_astm', label: 'BD ASTM' },
  { key: 'bd_jis', label: 'BD JIS' },
  { key: 'grit', label: 'GRIT' },
  { key: 'vm', label: 'VM' },
  { key: 'fc', label: 'FC' },
];

// ─── Document builder ─────────────────────────────────────────────────────────

/**
 * Build the blend-proposal jsPDF document from the structured payload. Returns the
 * `jsPDF` instance (caller triggers `.save(filename)` in the browser, or
 * `.output('arraybuffer')` in a test/node context). Pure aside from constructing the doc.
 *
 * `showPricesPref` is the client display preference (the Blocking "Prices" toggle), ANDed
 * with the server `can_view_prices` gate — hide-only, defaults to `true`. When false, the
 * PDF carries NO ₱ anywhere (per-block PHP/KG column, raw price, product cost, formula).
 */
/**
 * The supplier/age picture for the block table — the SAME record the modal renders.
 *
 * Passed in, never fetched: the PDF is a pure function of what was on screen, so the
 * two cannot disagree. Absent → the three columns print `-`, exactly as the screen
 * prints an em dash. It carries NO money and is therefore never price-gated.
 */
export interface BlendPdfFacts {
  facts: Record<string, BlendBlockFacts>;
  /** `block_loc` → batch id, for a live what-if whose blocks carry none. */
  batchIdByLoc?: Record<string, string | null>;
  /** The day the picture describes, printed under the table when it is not today. */
  asOf?: string | null;
}

export function buildBlendPdf(
  proposal: BlendProposal,
  showPricesPref = true,
  date: Date = new Date(),
  meta?: BlendDocMeta | null,
  blockFacts?: BlendPdfFacts | null,
  /**
   * The ANALYSIS PAGES (2026-09-21) — the same payload, the same chosen pages and the
   * same words the screen and the HTML printout use. Absent → the document is exactly
   * what it was before the analysis existed.
   */
  analysis?: BlendPdfAnalysis | null,
  /**
   * The YARD MAP (2026-09-23) — the model the HTML printout already built, so the two
   * documents cannot describe different yards. Absent → the file is exactly what it was
   * before the map existed.
   */
  yardMap?: BlendYardMapModel | null,
  /**
   * PAGE ONE'S MARKET CHART (2026-09-26) — the SAME slot the HTML printout draws (the
   * chart model, or the "unavailable" note). Absent → the file is exactly what it was
   * before the chart existed.
   */
  marketSlot?: BlendMarketChartSlot | null,
): jsPDF {
  const showPrices = proposal.can_view_prices && showPricesPref && proposal.raw_price_per_kg !== null;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const marginX = 40;
  let y = 48;

  // ── Title — the proposal's own name when it has one, else the generic heading ──
  const heading = (meta?.title ?? '').trim() || 'Blend Proposal';
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(0, 0, 0);
  doc.text(heading, marginX, y);

  // ── Subtitle: date + block count + combined balance ──
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90, 90, 90);
  const subtitle = `${format(date, 'yyyy-MM-dd')}  -  ${proposal.block_count} block${
    proposal.block_count === 1 ? '' : 's'
  }  -  ${fmtKg(proposal.total_balance)} kg combined balance`;
  doc.text(subtitle, marginX, y);

  // ── Saved-version line: `v3 - as proposed 2026-09-02` ──
  // The snapshot's OWN date, never the print clock: the document says when the yard
  // looked like this. Absent for a live what-if, which prints exactly as before.
  const versionLine = blendVersionLine(meta).replace(/ · /g, ' - ');
  if (versionLine) {
    y += 13;
    doc.setFontSize(9);
    doc.text(versionLine, marginX, y);
  }

  // ── The REMARK, wrapped ──
  const remark = (meta?.notes ?? '').trim();
  if (remark) {
    y += 13;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    const lines = doc.splitTextToSize(remark, 760) as string[];
    doc.text(lines, marginX, y);
    y += (lines.length - 1) * 11;
    doc.setFont('helvetica', 'normal');
  }

  y += 18;

  // ── Summary ──
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Summary', marginX, y);
  y += 6;

  autoTable(doc, {
    startY: y,
    theme: 'plain',
    margin: { left: marginX, right: marginX },
    styles: { fontSize: 9, cellPadding: 2, textColor: [20, 20, 20] },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 120 }, 1: { halign: 'right', cellWidth: 120 } },
    body: [
      ['Total Balance', `${fmtKg(proposal.total_balance)} kg`],
      ['Blocks', String(proposal.block_count)],
    ],
  });
  // @ts-expect-error lastAutoTable is added by the autotable plugin at runtime.
  y = doc.lastAutoTable.finalY + 16;

  // ── Weighted lab stats ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Blended Lab Stats (Weighted Avg)', marginX, y);
  y += 6;
  autoTable(doc, {
    startY: y,
    theme: 'grid',
    margin: { left: marginX, right: marginX },
    styles: { fontSize: 9, cellPadding: 4, halign: 'center', lineColor: [200, 200, 200], lineWidth: 0.5 },
    headStyles: { fillColor: [238, 238, 238], textColor: [40, 40, 40], fontStyle: 'bold' },
    head: [LAB_KEYS.map((l) => l.label)],
    body: [LAB_KEYS.map((l) => fmtLab(l.key, proposal.weighted[l.key]))],
  });
  // @ts-expect-error lastAutoTable runtime field.
  y = doc.lastAutoTable.finalY + 16;

  // ── Pricing (gated) ──
  if (showPrices && proposal.raw_price_per_kg !== null) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('Pricing', marginX, y);
    y += 6;

    const priceRows: string[][] = [['Raw blended price', `${fmtPhp(proposal.raw_price_per_kg)} /kg`]];
    if (proposal.product_cost_per_kg !== null) {
      priceRows.push(['Product cost', `${fmtPhp(proposal.product_cost_per_kg)} /kg`]);
    }
    autoTable(doc, {
      startY: y,
      theme: 'plain',
      margin: { left: marginX, right: marginX },
      styles: { fontSize: 9, cellPadding: 2, textColor: [20, 20, 20] },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 160 }, 1: { halign: 'right', cellWidth: 160 } },
      body: priceRows,
    });
    // @ts-expect-error lastAutoTable runtime field.
    y = doc.lastAutoTable.finalY + 10;

    if (proposal.product_cost_per_kg !== null) {
      const multiplier = (1 + proposal.production_loss_pct / 100).toFixed(2);
      const formula = `Raw blend ${fmtPhp(proposal.raw_price_per_kg)} x ${multiplier} (${proposal.production_loss_pct}% production loss) = ${fmtPhp(
        proposal.product_cost_per_kg,
      )} /kg product cost`;
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(80, 80, 80);
      doc.text(formula, marginX, y);
      doc.setTextColor(0, 0, 0);
      y += 18;
    }
  }

  // ── PAGE ONE'S MARKET CHART (2026-09-26) ──
  // It takes EXACTLY what is left of page one (down to the bottom margin), so page one
  // is one page by construction; the Selected Blocks table then starts on sheet two.
  // A failed read draws a one-line note in its place — never a failed PDF.
  if (marketSlot) {
    const pageH = doc.internal.pageSize.getHeight();
    drawMarketChartPdf(doc, marginX, y + 2, pageH - 28, marketSlot);
    doc.addPage();
    y = 48;
  }

  // ── Selected Blocks (per-block lab columns + gated PHP/KG) ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Selected Blocks', marginX, y);
  y += 6;

  // Block · Batch · SUPPLIER · OPENED · LAST PILED · Balance · 7 labs · [PHP/KG].
  // The three added columns carry no money and are NOT price-gated.
  const factsOf = (b: (typeof proposal.blocks)[number]): BlendBlockFacts | null => {
    if (!blockFacts) return null;
    const id = b.batch_id ?? blockFacts.batchIdByLoc?.[b.block_loc] ?? null;
    return (id && blockFacts.facts[id]) || null;
  };
  /** `Llanto 71%` / `Ornales` / `-`. `isSingleSupplier` IS the rule — never a length. */
  const supplierText = (f: BlendBlockFacts | null): string => {
    if (!f || f.isSingleSupplier === null || f.dominantSupplierDisplay === null) return '-';
    if (f.isSingleSupplier) return f.dominantSupplierDisplay;
    const share = f.dominantSharePct === null ? '' : ` ${Math.round(f.dominantSharePct)}%`;
    return `${f.dominantSupplierDisplay}${share}`;
  };
  const dayText = (v: number | null | undefined): string =>
    v === null || v === undefined ? '-' : `${Math.round(v)} d`;

  const head = [
    'Block',
    'Batch',
    'Supplier',
    'Opened',
    'Last piled',
    'Balance (kg)',
    ...LAB_KEYS.map((l) => l.label),
  ];
  if (showPrices) head.push('PHP/KG');

  const body = proposal.blocks.map((b) => {
    const f = factsOf(b);
    const row: string[] = [
      b.block_loc,
      b.batch_code,
      supplierText(f),
      dayText(f?.daysSinceOpened),
      dayText(f?.daysSinceLastPiled),
      fmtKg(b.balance),
      ...LAB_KEYS.map((l) => fmtLab(l.key, b[l.key])),
    ];
    if (showPrices) row.push(b.php_kg !== null ? fmtPhp(b.php_kg) : '-');
    return row;
  });

  // Footer total row: "Total" under Batch, blanks under the three added columns,
  // then balance, then blanks for labs/price.
  const footRow: string[] = [
    '',
    'Total',
    '',
    '',
    '',
    `${fmtKg(proposal.total_balance)} kg`,
    ...LAB_KEYS.map(() => ''),
  ];
  if (showPrices) footRow.push('');

  // Right-align the numeric columns: Opened, Last piled, Balance, the 7 labs and
  // PHP/KG when present. Supplier stays LEFT — it is a name.
  const columnStyles: Record<number, { halign: 'right' }> = {};
  for (let i = 3; i < head.length; i++) columnStyles[i] = { halign: 'right' };

  autoTable(doc, {
    startY: y,
    theme: 'grid',
    margin: { left: marginX, right: marginX },
    tableWidth: 'auto',
    styles: { fontSize: 7.5, cellPadding: 2.5, lineColor: [180, 180, 180], lineWidth: 0.5, overflow: 'linebreak' },
    headStyles: { fillColor: [238, 238, 238], textColor: [30, 30, 30], fontStyle: 'bold', halign: 'left', fontSize: 7 },
    footStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0], fontStyle: 'bold' },
    columnStyles,
    head: [head],
    body,
    foot: [footRow],
  });

  if (blockFacts?.asOf) {
    // @ts-expect-error lastAutoTable runtime field.
    const afterTable = doc.lastAutoTable.finalY + 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(90, 90, 90);
    doc.text(`Supplier and age as of ${blockFacts.asOf}.`, marginX, afterTable);
    doc.setTextColor(20, 20, 20);
  }

  // ── Document footer ──
  // @ts-expect-error lastAutoTable runtime field.
  const afterTableY: number = doc.lastAutoTable.finalY ?? y;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text(
    `Blackwood - Blend proposal - Generated ${format(date, 'yyyy-MM-dd HH:mm')}`,
    marginX,
    afterTableY + 18,
  );

  // ── The YARD MAP, on its own sheet, directly after the blocks table ──
  // It describes the block list above it, so it comes BEFORE the analysis sheets — the
  // same position the HTML printout puts it in.
  if (yardMap) drawYardMapPage(doc, marginX, yardMap);

  // ── The ANALYSIS PAGES, one per chosen page, each on its own sheet ──
  if (analysis) appendAnalysisPages(doc, marginX, analysis);

  return doc;
}

// ─── The analysis pages ───────────────────────────────────────────────────────
//
// Same payload, same order, same words as the screen and the HTML printout (the words
// come from `blend-analysis-text.ts`, which both surfaces already share). What differs
// is only what jsPDF needs: `PHP ` instead of `₱` (its built-in Helvetica is WinAnsi
// and has no peso glyph), RGB fill arrays instead of CSS, and a `didParseCell` hook
// instead of a class for the subtotal / footer rows.
//
// NOTHING IS RE-DERIVED: every subtotal and footer figure is the payload's own group /
// `overall` field, and the only arithmetic is the per-ROW `kg × ₱/kg` product the other
// two surfaces also show.

/** What the analysis pages need — the screen's own inputs, unchanged. */
export interface BlendPdfAnalysis {
  analysis: BlendAnalysis | null;
  options: BlendAnalysisOptions;
  /** The EFFECTIVE price flag. False → no price page, and the payload carries no ₱. */
  canViewPrices: boolean;
  priceBandNames?: Record<string, string>;
  ageBandNames?: Record<string, string>;
  labHighlights: Record<LabMetric, LabHighlightSpec>;
}

/** A row tagged so the cell hook can paint it. */
interface AnalysisPdfRow {
  cells: string[];
  kind: 'head' | 'block' | 'sub' | 'total' | 'muted';
  /** The group tint, for a `head` row. */
  fill?: [number, number, number];
}

/** `rgb(r g b)` → jsPDF's own `[r, g, b]`, lightened onto white for a row fill. */
function tintFill(triple: string): [number, number, number] {
  const [r, g, b] = triple.split(' ').map(Number);
  // 18% of the hue over white — the same weight the screen's `rgb(… / 0.18)` carries.
  const mix = (c: number) => Math.round(255 - (255 - c) * 0.18);
  return [mix(r), mix(g), mix(b)];
}

/**
 * ONE TABLE, ONE PAGE — it calls `addPage()` FIRST, every time.
 *
 * The HTML sheets get this from `.apage { break-before: page }`; here it has to be the
 * explicit `addPage()`, and it has to happen for EVERY table rather than once per
 * chosen page, or a heading lands at the bottom of a sheet above the tail of the table
 * before it — which is exactly what the owner photographed. Six tables therefore mean
 * six added pages, and the page count is the honest consequence.
 */
function analysisHeading(doc: jsPDF, marginX: number, title: string, note: string): number {
  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(0, 0, 0);
  doc.text(title, marginX, 48);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  const lines = doc.splitTextToSize(note, 760) as string[];
  doc.text(lines, marginX, 62);
  doc.setTextColor(20, 20, 20);
  return 62 + lines.length * 10 + 6;
}

function analysisTable(
  doc: jsPDF,
  marginX: number,
  startY: number,
  head: string[],
  rows: AnalysisPdfRow[],
  numericFrom: number,
): number {
  const columnStyles: Record<number, { halign: 'right' }> = {};
  for (let i = numericFrom; i < head.length; i++) columnStyles[i] = { halign: 'right' };

  autoTable(doc, {
    startY,
    theme: 'grid',
    margin: { left: marginX, right: marginX },
    styles: { fontSize: 7.5, cellPadding: 2, lineColor: [170, 170, 170], lineWidth: 0.5 },
    headStyles: {
      fillColor: [238, 238, 238],
      textColor: [30, 30, 30],
      fontStyle: 'bold',
      halign: 'left',
      fontSize: 7,
    },
    columnStyles,
    head: [head.map(pdfText)],
    // EVERY cell goes through `pdfText`: jsPDF's built-in Helvetica is WinAnsi, so a
    // stray `₱`, em dash or `·` from the shared text module would print as garbage.
    body: rows.map((r) => r.cells.map(pdfText)),
    // A group header spans the table; the subtotal and the grand total are BODY rows
    // (never a `foot`, which jspdf-autotable repeats on every page — the same reason
    // the HTML sheets avoid `<tfoot>`).
    didParseCell: (data) => {
      if (data.section !== 'body') return;
      const row = rows[data.row.index];
      if (!row) return;
      if (row.kind === 'head') {
        data.cell.styles.fontStyle = 'bold';
        if (row.fill) data.cell.styles.fillColor = row.fill;
        if (data.column.index === 0) data.cell.colSpan = head.length;
      }
      if (row.kind === 'sub') {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [244, 244, 244];
        if (data.column.index === 0) data.cell.colSpan = 2;
      }
      if (row.kind === 'total') {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [233, 233, 233];
        if (data.column.index === 0) data.cell.colSpan = 2;
      }
      if (row.kind === 'muted') data.cell.styles.textColor = [110, 110, 110];
    },
  });
  // @ts-expect-error lastAutoTable runtime field.
  return doc.lastAutoTable.finalY as number;
}

function appendAnalysisPages(doc: jsPDF, marginX: number, input: BlendPdfAnalysis): void {
  const { analysis, options, canViewPrices, labHighlights } = input;
  if (!analysis) return;

  for (const page of analysisPages(options, canViewPrices)) {
    if (page === 'price') {
      const price = analysis.price;
      if (!price) continue;
      const nat = price.natural;
      const y = analysisHeading(
        doc,
        marginX,
        'Price groups - natural breaks',
        pdfText(
          [
            naturalMethodNote({
              groupCount: nat.groupCount,
              cuts: nat.cuts,
              gvf: nat.gvf,
              formatCut: (v) => pdfPhp(v),
            }),
            unmeasuredNote(nat.unmeasured, 'No price'),
          ]
            .filter((s) => s !== '')
            .join(' · '),
        ),
      );

      const priceHead = ['Block', 'Batch', 'Balance (kg)', 'PHP/KG', 'Value'];
      const rows: AnalysisPdfRow[] = [];
      for (const g of [...nat.groups].sort((a, b) => b.index - a.index)) {
        rows.push({
          kind: 'head',
          fill: tintFill(rampRgb('cost', g.index, nat.groupCount)),
          cells: [
            `${groupWord(g.label, nat.groupCount)}   ${pdfPhp(g.rangeMin)} - ${pdfPhp(g.rangeMax)}`,
            '',
            '',
            '',
            '',
          ],
        });
        for (const b of g.blocks) {
          rows.push({
            kind: 'block',
            cells: [
              b.blockLoc,
              b.batchCode,
              fmtKg(b.kg),
              pdfPhp(b.phpKg),
              pdfPhp(b.kg * b.phpKg, 0),
            ],
          });
        }
        rows.push({
          kind: 'sub',
          cells: [
            `${groupWord(g.label, nat.groupCount)} subtotal - ${blocksWord(
              g.blockCount,
            )} - ${fmtSharePct(g.kgSharePct)} of kg`,
            '',
            `${fmtKg(g.kg)} kg`,
            pdfPhpOrDash(g.kgWeightedPhpKg),
            pdfPhp(g.valuePhp, 0),
          ],
        });
      }
      pushMuted(rows, nat.unmeasured.blocks, priceHead.length, 'No price');
      rows.push({
        kind: 'total',
        cells: [
          `Whole blend - ${blocksWord(nat.overall.blockCount)}`,
          '',
          `${fmtKg(nat.overall.kg)} kg`,
          pdfPhpOrDash(nat.overall.kgWeightedPhpKg),
          pdfPhp(nat.overall.valuePhp, 0),
        ],
      });
      analysisTable(doc, marginX, y, priceHead, rows, 2);

      // ── Against market / set price — ITS OWN PAGE ──
      const vm = price.vsMarket;
      const typed = vm
        ? vm.marketBasis === 'given'
        : price.vsMarketUnavailable?.marketBasis === 'given';
      const vmY = analysisHeading(
        doc,
        marginX,
        vsMarketHeading(!!typed),
        vm
          ? pdfText(vsMarketCaption(vm))
          : pdfText(
              price.vsMarketUnavailable
                ? vsMarketUnavailableNote(price.vsMarketUnavailable)
                : 'No comparison available',
            ),
      );
      if (vm) {
        const vmRows: AnalysisPdfRow[] = [];
        for (const b of [...vm.bands].sort((a, x) => x.index - a.index)) {
          vmRows.push({
            kind: 'head',
            fill: tintFill(rampRgb('cost', b.index, vm.bands.length)),
            cells: [pdfText(priceBandLabel(b, vm.roundedUpPhp, input.priceBandNames ?? {})), '', '', '', ''],
          });
          for (const blk of b.blocks) {
            vmRows.push({
              kind: 'block',
              cells: [
                blk.blockLoc,
                blk.batchCode,
                fmtKg(blk.kg),
                pdfPhp(blk.phpKg),
                pdfPhp(blk.kg * blk.phpKg, 0),
              ],
            });
          }
          vmRows.push({
            kind: 'sub',
            cells: [
              `Band subtotal - ${blocksWord(b.blockCount)} - ${fmtSharePct(b.kgSharePct)} of kg`,
              '',
              `${fmtKg(b.kg)} kg`,
              pdfPhpOrDash(b.kgWeightedPhpKg),
              pdfPhp(b.valuePhp, 0),
            ],
          });
        }
        pushMuted(vmRows, vm.unmeasured.blocks, priceHead.length, 'No price');
        vmRows.push({
          kind: 'total',
          cells: [
            `Whole blend - ${blocksWord(vm.overall.blockCount)}`,
            '',
            `${fmtKg(vm.overall.kg)} kg`,
            pdfPhpOrDash(vm.overall.kgWeightedPhpKg),
            pdfPhp(vm.overall.valuePhp, 0),
          ],
        });
        analysisTable(doc, marginX, vmY, priceHead, vmRows, 2);
      }
    }

    if (page === 'quality') {
      for (const { metric, companion } of QUALITY_PDF_TABLES) {
        const nat = analysis.quality.byMetric[metric];
        const comp = companion ? analysis.quality.byMetric[companion] : null;
        const compByBlock = new Map<string, number>();
        if (comp) for (const g of comp.groups) for (const b of g.blocks) compByBlock.set(b.blockLoc, b.value);

        const head = ['Block', 'Batch', 'Balance (kg)', QUALITY_METRIC_LABELS[metric]];
        if (companion) head.push(QUALITY_METRIC_LABELS[companion]);

        const rows: AnalysisPdfRow[] = [];
        for (const g of [...nat.groups].sort((a, b) => b.index - a.index)) {
          rows.push({
            kind: 'head',
            fill: tintFill(rampRgb('age', g.index, nat.groupCount)),
            cells: padCells(
              [
                `${groupWord(g.label, nat.groupCount)}   ${fmtQuality(
                  metric,
                  g.rangeMin,
                )} - ${fmtQuality(metric, g.rangeMax)}`,
              ],
              head.length,
            ),
          });
          for (const b of g.blocks) {
            const cells = [b.blockLoc, b.batchCode, fmtKg(b.kg), fmtQuality(metric, b.value)];
            if (companion) {
              const cv = compByBlock.get(b.blockLoc);
              cells.push(cv === undefined ? '-' : fmtQuality(companion, cv));
            }
            rows.push({ kind: 'block', cells });
          }
          const sub = [
            `${groupWord(g.label, nat.groupCount)} subtotal - ${blocksWord(
              g.blockCount,
            )} - ${fmtSharePct(g.kgSharePct)} of kg`,
            '',
            `${fmtKg(g.kg)} kg`,
            fmtQuality(metric, g.kgWeightedValue),
          ];
          if (companion) sub.push('-');
          rows.push({ kind: 'sub', cells: sub });
        }
        pushMuted(rows, nat.unmeasured.blocks, head.length, 'No reading');
        const total = [
          `Whole blend - ${blocksWord(nat.overall.blockCount)}`,
          '',
          `${fmtKg(nat.overall.kg)} kg`,
          fmtQuality(metric, nat.overall.kgWeightedValue),
        ];
        if (companion && comp) total.push(fmtQuality(companion, comp.overall.kgWeightedValue));
        rows.push({ kind: 'total', cells: total });

        // ONE PAGE PER METRIC — `analysisHeading` adds the page itself.
        const y = analysisHeading(
          doc,
          marginX,
          `Quality - ${QUALITY_METRIC_LABELS[metric]}${
            companion ? ` + ${QUALITY_METRIC_LABELS[companion]}` : ''
          } - ${QUALITY_METRIC_UNITS[metric]}`,
          pdfText(
            [
              naturalMethodNote({
                groupCount: nat.groupCount,
                cuts: nat.cuts,
                gvf: nat.gvf,
                formatCut: (v) => v.toFixed(metric === 'bd_astm' || metric === 'bd_jis' ? 3 : 2),
              }),
              unmeasuredNote(nat.unmeasured, 'No reading'),
            ]
              .filter((s) => s !== '')
              .join(' · '),
          ),
        );
        analysisTable(doc, marginX, y, head, rows, 2);
      }
      // The thresholds are the reader's own; naming them keeps the colour honest even
      // in a PDF a printer renders in grey.
      void labHighlights;
    }

    if (page === 'age') {
      const age = analysis.age;
      const o = age.overall;
      const y = analysisHeading(
        doc,
        marginX,
        'Age',
        pdfText(
          [
            ageMethodNote({
              asOf: age.asOf,
              cutDays: age.bands.map((b) => b.lowerDays).filter((d) => d > 0),
              oldestDays: o.oldestAgeDays,
              oldestBlockLoc: o.oldestBlockLoc,
            }),
            undatedNote(age.undated.blockCount),
          ]
            .filter((s) => s !== '')
            .join(' · '),
        ),
      );
      const head = ['Block', 'Batch', 'Balance (kg)', 'Age (d)', 'First delivery', 'Last delivery'];
      const rows: AnalysisPdfRow[] = [];
      for (const b of [...age.bands].sort((a, x) => x.index - a.index)) {
        rows.push({
          kind: 'head',
          fill: tintFill(rampRgb('age', b.index, age.bands.length)),
          cells: padCells([pdfText(ageBandLabel(b, input.ageBandNames ?? {}))], head.length),
        });
        for (const blk of b.blocks) {
          rows.push({
            kind: 'block',
            cells: [
              blk.blockLoc,
              blk.batchCode,
              fmtKg(blk.kg),
              fmtDays(blk.ageDays),
              blk.firstDeliveryDate ?? '-',
              blk.lastDeliveryDate ?? '-',
            ],
          });
        }
        rows.push({
          kind: 'sub',
          cells: [
            `Band subtotal - ${blocksWord(b.blockCount)} - ${fmtSharePct(b.kgSharePct)} of kg`,
            '',
            `${fmtKg(b.kg)} kg`,
            fmtDays(b.kgWeightedAgeDays),
            '-',
            '-',
          ],
        });
      }
      pushMuted(rows, age.undated.blocks, head.length, 'No delivery dates');
      rows.push({
        kind: 'total',
        cells: [
          `Whole blend - ${blocksWord(o.blockCount)}`,
          '',
          `${fmtKg(o.kg)} kg`,
          fmtDays(o.kgWeightedAgeDays),
          '-',
          '-',
        ],
      });
      analysisTable(doc, marginX, y, head, rows, 2);
    }
  }
}

/** `PHP 43.56` — the PDF's own currency spelling. An em dash becomes a plain `-`. */
function pdfPhp(v: number, decimals = 2): string {
  return `PHP ${v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function pdfPhpOrDash(v: number | null, decimals = 2): string {
  return v === null ? '-' : pdfPhp(v, decimals);
}

/** WinAnsi has no `₱`, no em dash and no `→`; the PDF spells them out. */
function pdfText(s: string): string {
  return s
    .replace(/₱/g, 'PHP ')
    .replace(/—|–/g, '-')
    .replace(/→/g, 'to')
    .replace(/·/g, '-')
    .replace(/…/g, '...')
    .replace(/’/g, "'");
}

function padCells(cells: string[], length: number): string[] {
  const out = [...cells];
  while (out.length < length) out.push('');
  return out;
}

/** The blocks with no reading — one muted group, never folded into the first one. */
function pushMuted(
  rows: AnalysisPdfRow[],
  blocks: readonly { blockLoc: string; batchCode: string; kg: number }[],
  colCount: number,
  label: string,
): void {
  if (blocks.length === 0) return;
  rows.push({ kind: 'head', cells: padCells([label], colCount) });
  for (const b of blocks) {
    rows.push({
      kind: 'muted',
      cells: padCells([b.blockLoc, b.batchCode, fmtKg(b.kg)], colCount).map((c, i) =>
        i >= 3 ? '-' : c,
      ),
    });
  }
}

const QUALITY_PDF_TABLES: { metric: BlendQualityMetric; companion?: BlendQualityMetric }[] = [
  { metric: 'mc' },
  { metric: 'ash' },
  { metric: 'bd_astm', companion: 'bd_jis' },
];

// ─── The YARD MAP page ────────────────────────────────────────────────────────
//
// ⚠️ DRAWN NATIVELY — rectangles and text, never a rasterised screenshot.
//
// The obvious shortcut would be to render the HTML sheet and photograph it, but this
// document has no DOM to render into (it is built from the payload, in a worker-free pure
// function, and is the one surface that also runs in Node for tests), and the project has
// no html2canvas. More to the point the map IS rectangles and five-character labels, so
// drawing them keeps the text SELECTABLE and the file small — the same reason
// `buildBlendPdf` exists at all rather than screenshotting the modal.
//
// ── ONE MODEL, ONE SOLVE, ONE PALETTE ───────────────────────────────────────
// The cells, the bands, the caption and the legend come from `BlendYardMapModel` — the
// SAME object the HTML sheet consumes — and the cell edge and font come from
// `solveYardMapFit` via `blendYardMapFit`. The only thing this function adds is the unit
// conversion: the solve works in CSS px at 96 dpi and jsPDF works in POINTS, so every
// length is multiplied by 72/96. The box is solved against THIS document's own margin
// (derived from `marginX` in points), so the drawing and the arithmetic cannot disagree.
//
// NO ₱, no kilogram, no lab reading — it is slots and colours.

/** CSS px → typographic points. The solve is in px at 96 dpi; jsPDF is in pt. */
const PT_PER_PX = 72 / 96;

/** `rgb(r g b)` or `#rrggbb` → jsPDF's own `[r, g, b]`. */
function cssRgb(value: string): [number, number, number] {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  const nums = trimmed.replace(/^rgb\(/, '').replace(/\)$/, '').split(/[\s,/]+/).filter((t) => t !== '');
  return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
}

function setFill(doc: jsPDF, css: string): void {
  const [r, g, b] = cssRgb(css);
  doc.setFillColor(r, g, b);
}

function setStroke(doc: jsPDF, css: string): void {
  const [r, g, b] = cssRgb(css);
  doc.setDrawColor(r, g, b);
}

function setInk(doc: jsPDF, css: string): void {
  const [r, g, b] = cssRgb(css);
  doc.setTextColor(r, g, b);
}

/**
 * Page one's market chart (or its "unavailable" note), drawn into the box `[top, bottom]`
 * of the CURRENT page. The geometry is `layoutBlendMarketChart` — the SAME function the
 * HTML printout's SVG uses — laid out in points with jsPDF's own text measure, so the two
 * documents draw one chart. Nothing here reads a number the model did not publish.
 */
function drawMarketChartPdf(
  doc: jsPDF,
  marginX: number,
  top: number,
  bottom: number,
  slot: BlendMarketChartSlot,
): void {
  const width = doc.internal.pageSize.getWidth() - 2 * marginX;
  let y = top;

  // ── Heading: the model's own title + range ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);
  const title = slot.kind === 'chart' ? slot.model.title : BLEND_MARKET_CHART_TITLE;
  doc.text(pdfText(title), marginX, y);
  if (slot.kind === 'chart') {
    const tw = doc.getTextWidth(pdfText(title));
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(63, 63, 70);
    doc.text(pdfText(slot.model.range), marginX + tw + 8, y);
  }
  y += 11;

  if (slot.kind === 'unavailable') {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(24, 24, 27);
    const head = `${BLEND_MARKET_UNAVAILABLE_HEADLINE}.`;
    doc.text(head, marginX, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(63, 63, 70);
    const hw = doc.getTextWidth(head) + 4;
    const lines = doc.splitTextToSize(pdfText(slot.reason), width - hw) as string[];
    doc.text(lines, marginX + hw, y);
    doc.setTextColor(20, 20, 20);
    return;
  }

  const model = slot.model;

  // ── Subtitle (the definitions) ──
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(63, 63, 70);
  const sub = doc.splitTextToSize(pdfText(model.subtitle), width) as string[];
  doc.text(sub, marginX, y);
  y += sub.length * 9 + 2;

  // ── Legend ──
  doc.setFontSize(7.5);
  let lx = marginX;
  doc.setLineWidth(1);
  for (const e of model.legend) {
    const text = pdfText(e.label);
    const w = 16 + doc.getTextWidth(text) + 12;
    if (lx + w > marginX + width && lx > marginX) {
      lx = marginX;
      y += 10;
    }
    setStroke(doc, e.stroke);
    if (e.kind === 'area') {
      setFill(doc, e.fill ?? e.stroke);
      doc.setGState(new GState({ opacity: BLEND_MARKET_AREA_OPACITY }));
      doc.rect(lx, y - 6, 11, 7, 'F');
      doc.setGState(new GState({ opacity: 1 }));
      doc.setLineWidth(0.8);
      doc.rect(lx, y - 6, 11, 7, 'S');
    } else {
      doc.setLineWidth(e.kind === 'line' ? 2 : 1);
      if (e.kind === 'ref') doc.setLineDashPattern([3, 2], 0);
      doc.line(lx, y - 2.5, lx + 12, y - 2.5);
      if (e.kind === 'ref') doc.setLineDashPattern([], 0);
    }
    doc.setTextColor(24, 24, 27);
    doc.text(text, lx + 16, y);
    lx += w;
  }
  y += 6;

  // ── Footnotes, measured first so the plot takes exactly what is left ──
  doc.setFontSize(7);
  const noteLines = model.footnotes.flatMap(
    (f) => doc.splitTextToSize(`- ${pdfText(f)}`, width) as string[],
  );
  const notesH = noteLines.length * 8.5;
  const plotH = Math.max(90, bottom - y - notesH - (noteLines.length ? 4 : 0));

  // ── The plot, in points ──
  const FONT = 7;
  doc.setFontSize(FONT);
  const layout = layoutBlendMarketChart(model, width, plotH, FONT, 0.55, (s) =>
    doc.getTextWidth(pdfText(s)),
  );
  const ox = marginX;
  const oy = y;
  const P = (p: { x: number; y: number }) => ({ x: ox + p.x, y: oy + p.y });

  // Guides.
  setStroke(doc, BLEND_MARKET_INK.grid);
  doc.setLineWidth(0.5);
  for (const gy of layout.guides) {
    doc.line(ox + layout.plot.x, oy + gy, ox + layout.plot.x + layout.plot.w, oy + gy);
  }

  const polyPath = (pts: { x: number; y: number }[], style: 'F' | 'S', closed: boolean) => {
    const abs = pts.map(P);
    const deltas = abs.slice(1).map((p, i) => [p.x - abs[i].x, p.y - abs[i].y]);
    doc.lines(deltas, abs[0].x, abs[0].y, [1, 1], style, closed);
  };

  // Areas, BEHIND everything else: a translucent fill, then an opaque edge.
  for (const a of layout.areas) {
    for (const poly of a.polygons) {
      setFill(doc, a.fill);
      doc.setGState(new GState({ opacity: BLEND_MARKET_AREA_OPACITY }));
      polyPath(poly, 'F', true);
      doc.setGState(new GState({ opacity: 1 }));
      setStroke(doc, a.stroke);
      doc.setLineWidth(0.8);
      // The top edge only — the polygon's first and last points are on the baseline.
      polyPath(poly.slice(1, -1).length > 1 ? poly.slice(1, -1) : poly, 'S', false);
    }
  }

  // Baseline.
  setStroke(doc, BLEND_MARKET_INK.axis);
  doc.setLineWidth(0.7);
  doc.line(ox + layout.plot.x, oy + layout.baselineY, ox + layout.plot.x + layout.plot.w, oy + layout.baselineY);

  // Reference level.
  if (layout.ref) {
    setStroke(doc, BLEND_MARKET_INK.ref);
    doc.setLineWidth(0.8);
    doc.setLineDashPattern([4, 2.5], 0);
    doc.line(ox + layout.ref.x1, oy + layout.ref.y, ox + layout.ref.x2, oy + layout.ref.y);
    doc.setLineDashPattern([], 0);
  }

  // Lines + dots (hollow = the partial month).
  for (const ln of layout.lines) {
    setStroke(doc, ln.stroke);
    doc.setLineWidth(1.6);
    for (const run of ln.runs) if (run.length > 1) polyPath(run, 'S', false);
    for (const d of ln.dots) {
      const p = P(d);
      if (d.hollow) {
        doc.setFillColor(255, 255, 255);
        doc.setLineWidth(1.2);
        doc.circle(p.x, p.y, 2.4, 'FD');
      } else {
        setFill(doc, ln.stroke);
        doc.circle(p.x, p.y, 1.9, 'F');
      }
    }
  }

  // Labels.
  for (const t of layout.texts) {
    doc.setFont('helvetica', t.bold ? 'bold' : t.italic ? 'italic' : 'normal');
    doc.setFontSize(t.size);
    setInk(doc, t.color);
    const align = t.anchor === 'start' ? 'left' : t.anchor === 'end' ? 'right' : 'center';
    doc.text(pdfText(t.text), ox + t.x, oy + t.y, { align });
  }

  // Footnotes.
  if (noteLines.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(63, 63, 70);
    doc.text(noteLines, marginX, oy + plotH + 8);
  }
  doc.setTextColor(20, 20, 20);
  doc.setDrawColor(0, 0, 0);
}

/**
 * The map, on its own landscape page, drawn cell by cell.
 *
 * `marginX` is the document's own left/right margin in POINTS; the map solves against the
 * box that margin implies, so a future change to one moves the other.
 */
function drawYardMapPage(doc: jsPDF, marginX: number, model: BlendYardMapModel): void {
  doc.addPage();

  // ── ONE heading line, the model's own — slot count, as-of caption, what it is for ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(0, 0, 0);
  doc.text('Yard map', marginX, 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(80, 80, 80);
  doc.text(pdfText(model.headline), marginX + 62, 40);

  // ── The solve, in points ──
  // The box comes from THIS document's own margin (the drawing and the arithmetic cannot
  // disagree) and the chrome budget is the sheet's own, shared with the HTML path.
  const marginMm = (marginX / 72) * 25.4;
  const fit = blendYardMapSolve(model, marginMm);
  const stops = blendYardMapStops(model);
  const cell = fit.cells.cellPx * PT_PER_PX;
  const gutter = YARD_MAP_GUTTER_PX * PT_PER_PX;
  const labelH = YARD_MAP_LABEL_H_PX * PT_PER_PX;
  const colHdrH = YARD_MAP_COLHDR_H_PX * PT_PER_PX;
  const laneGap = YARD_MAP_LANE_GAP_PX * PT_PER_PX;
  const sectionGap = YARD_MAP_SECTION_GAP_PX * PT_PER_PX;

  const lanes = [...new Set(model.map.sections.map((s) => s.lane))].sort((a, b) => a - b);
  let y = 52;

  doc.setLineWidth(0.4);
  for (const lane of lanes) {
    const sections = model.map.sections.filter((s) => s.lane === lane);
    let x = marginX;
    let laneHeight = 0;
    for (const section of sections) {
      // The warehouse label.
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(82, 82, 91);
      doc.text(section.label.toUpperCase(), x, y + labelH - 2);

      const gridTop = y + labelH;
      // Column numbers.
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.5);
      doc.setTextColor(113, 113, 122);
      section.cols.forEach((col, ci) => {
        doc.text(String(col), x + gutter + ci * cell + cell / 2, gridTop + colHdrH - 1, {
          align: 'center',
        });
      });

      const cellsTop = gridTop + colHdrH;
      section.rows.forEach((row, ri) => {
        // The row letter.
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.setTextColor(113, 113, 122);
        doc.text(row, x + gutter / 2, cellsTop + ri * cell + cell / 2 + 2, { align: 'center' });

        section.cells[ri].forEach((c, ci) => {
          const paint = lensYardMapPaint(c, model.ramp, stops);
          const cx = x + gutter + ci * cell;
          const cy = cellsTop + ri * cell;
          setFill(doc, paint.bg);
          setStroke(doc, LENS_YARD_MAP_HAIRLINE);
          doc.rect(cx, cy, cell, cell, 'FD');
          if (paint.outline) {
            // The DASHED INSET marker — a selected block the yard no longer holds.
            setStroke(doc, paint.outline);
            doc.setLineDashPattern([1.5, 1.5], 0);
            doc.rect(cx + 1.5, cy + 1.5, cell - 3, cell - 3, 'S');
            doc.setLineDashPattern([], 0);
          }
          const lines = fit.wrapAll
            ? lensYardMapLines(section.key, c.loc, true)
            : c.lines;
          const empty = paint.kind === 'empty';
          doc.setFont('helvetica', empty ? 'normal' : 'bold');
          doc.setFontSize(empty ? Math.min(fit.fontPt, 7.5) : fit.fontPt);
          setInk(doc, paint.ink);
          const lineH = fit.fontPt * 1.05;
          const first = cy + cell / 2 - ((lines.length - 1) * lineH) / 2 + fit.fontPt * 0.35;
          lines.forEach((line, li) => {
            doc.text(line, cx + cell / 2, first + li * lineH, { align: 'center' });
          });
        });
      });

      const sectionHeight = labelH + colHdrH + section.rows.length * cell;
      laneHeight = Math.max(laneHeight, sectionHeight);
      x = x + gutter + section.cols.length * cell + sectionGap;
    }
    y = y + laneHeight + laneGap;
  }

  // ── The legend — the SAME rows the HTML sheet prints ──
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setLineWidth(0.4);
  let lx = marginX;
  const ly = y + 6;
  for (const row of blendYardMapLegend(model)) {
    setFill(doc, row.bg);
    setStroke(doc, row.border);
    if (row.dashed) doc.setLineDashPattern([1, 1], 0);
    doc.rect(lx, ly - 5, 5, 5, 'FD');
    if (row.dashed) doc.setLineDashPattern([], 0);
    doc.setTextColor(63, 63, 70);
    const text = pdfText(row.text);
    doc.text(text, lx + 7, ly);
    lx = lx + 7 + doc.getTextWidth(text) + 12;
  }

  // The ONE footnote the model already composed — what the map cannot draw, said rather
  // than hidden. Wrapped to the printable width, never off the edge.
  if (model.note !== '') {
    doc.setTextColor(82, 82, 91);
    const width = doc.internal.pageSize.getWidth() - 2 * marginX;
    doc.text(doc.splitTextToSize(pdfText(model.note), width) as string[], marginX, ly + 10);
  }
  doc.setTextColor(20, 20, 20);
}

/**
 * Generate the blend-proposal PDF and trigger a browser download named
 * `YYMMDD - {label}.pdf`. Throws on a blank/illegal label or any jsPDF failure — the
 * caller surfaces it via `errorToast()`.
 *
 * `showPricesPref` is the client display preference (hide-only, ANDed with the server
 * gate inside `buildBlendPdf`). When false the saved PDF carries NO ₱.
 */
export function downloadBlendPdf(
  proposal: BlendProposal,
  label: string,
  showPricesPref = true,
  meta?: BlendDocMeta | null,
  blockFacts?: BlendPdfFacts | null,
  analysis?: BlendPdfAnalysis | null,
  yardMap?: BlendYardMapModel | null,
  marketSlot?: BlendMarketChartSlot | null,
): void {
  const filename = composeBlendPdfFilename(label);
  if (!filename) {
    throw new Error('A label is required to name the PDF.');
  }
  const doc = buildBlendPdf(
    proposal,
    showPricesPref,
    new Date(),
    meta,
    blockFacts,
    analysis,
    yardMap,
    marketSlot,
  );
  doc.save(filename);
}
