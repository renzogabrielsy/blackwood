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

// ─── Filename ─────────────────────────────────────────────────────────────────

/**
 * Reserved characters illegal/awkward in filenames across Windows/macOS/Linux:
 * `/ \ : * ? " < > |`. Spaces and dashes are intentionally KEPT (the user wants
 * `4x8 RUN` intact). Control characters are stripped separately by codepoint so this
 * regex carries no literal control bytes.
 */
const RESERVED_FILENAME_CHARS = /[/\\:*?"<>|]/g;

/**
 * Sanitize a user label for use in a filename. Strips the reserved characters
 * (`/ \ : * ? " < > |`) and any control characters (codepoint < 0x20), but KEEPS spaces
 * (`4x8 RUN` stays intact), collapses runs of whitespace, and trims. Returns `''` for an
 * all-illegal/blank label so callers can require a non-empty result.
 */
export function sanitizeLabel(label: string): string {
  return Array.from(label)
    .filter((ch) => ch.codePointAt(0)! >= 0x20) // drop control chars by codepoint
    .join('')
    .replace(RESERVED_FILENAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compose the blend-proposal PDF filename: `YYMMDD - {label}.pdf`, where YYMMDD is
 * `date` (defaults to NOW at call time — dynamic, never hardcoded) via date-fns. The
 * label is sanitized first. Returns `null` when the sanitized label is empty (the caller
 * should keep the Download button disabled until the label is non-empty).
 */
export function composeBlendPdfFilename(label: string, date: Date = new Date()): string | null {
  const safe = sanitizeLabel(label);
  if (!safe) return null;
  return `${format(date, 'yyMMdd')} - ${safe}.pdf`;
}

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
export function buildBlendPdf(proposal: BlendProposal, showPricesPref = true, date: Date = new Date()): jsPDF {
  const showPrices = proposal.can_view_prices && showPricesPref && proposal.raw_price_per_kg !== null;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const marginX = 40;
  let y = 48;

  // ── Title ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(0, 0, 0);
  doc.text('Blend Proposal', marginX, y);

  // ── Subtitle: date + block count + combined balance ──
  y += 18;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90, 90, 90);
  const subtitle = `${format(date, 'yyyy-MM-dd')}  -  ${proposal.block_count} block${
    proposal.block_count === 1 ? '' : 's'
  }  -  ${fmtKg(proposal.total_balance)} kg combined balance`;
  doc.text(subtitle, marginX, y);
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

  const head = ['Block', 'Batch', 'Balance (kg)', ...LAB_KEYS.map((l) => l.label)];
  if (showPrices) head.push('PHP/KG');

  const body = proposal.blocks.map((b) => {
    const row: string[] = [
      b.block_loc,
      b.batch_code,
      fmtKg(b.balance),
      ...LAB_KEYS.map((l) => fmtLab(l.key, b[l.key])),
    ];
    if (showPrices) row.push(b.php_kg !== null ? fmtPhp(b.php_kg) : '-');
    return row;
  });

  // Footer total row: "Total" under Batch, then balance, then blanks for labs/price.
  const footRow: string[] = ['', 'Total', `${fmtKg(proposal.total_balance)} kg`, ...LAB_KEYS.map(() => '')];
  if (showPrices) footRow.push('');

  // Right-align all numeric columns (Balance, the 7 labs, and PHP/KG when present).
  const numericFrom = 2; // index of "Balance (kg)"
  const columnStyles: Record<number, { halign: 'right' }> = {};
  for (let i = numericFrom; i < head.length; i++) columnStyles[i] = { halign: 'right' };

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
export function downloadBlendPdf(proposal: BlendProposal, label: string, showPricesPref = true): void {
  const filename = composeBlendPdfFilename(label);
  if (!filename) {
    throw new Error('A label is required to name the PDF.');
  }
  const doc = buildBlendPdf(proposal, showPricesPref);
  doc.save(filename);
}
