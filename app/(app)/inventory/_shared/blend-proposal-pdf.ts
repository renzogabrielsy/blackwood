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

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { BlendProposal } from '../blocking/actions';
import type { BlendBlockFacts } from '../blocking/types';
// PERF-4: the pure filename helpers live in a jspdf-free module so callers can import
// them WITHOUT pulling jsPDF into the bundle. Re-exported here for back-compat + the
// node/test path.
import { sanitizeLabel, composeBlendPdfFilename } from './blend-proposal-filename';
import { blendVersionLine, type BlendDocMeta } from './print-utils';

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

  return doc;
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
): void {
  const filename = composeBlendPdfFilename(label);
  if (!filename) {
    throw new Error('A label is required to name the PDF.');
  }
  const doc = buildBlendPdf(proposal, showPricesPref, new Date(), meta, blockFacts);
  doc.save(filename);
}
