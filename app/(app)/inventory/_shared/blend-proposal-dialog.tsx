'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  Calculator,
  Printer,
  X,
  Download,
  Save,
  Pencil,
  Archive,
  ArchiveRestore,
  GitCompare,
  Star,
  Sparkles,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import {
  EMDASH,
  escapeHtml,
  peso,
  printViaIframe,
  PRINT_CSS,
  blendVersionLine,
  blendComputedDate,
  type BlendDocMeta,
} from './print-utils';
import {
  blendLabDecimals,
  formatSignedDelta,
  type BlendComparison,
  type BlendLabKey,
} from '@/lib/blocking/blend-diff';
import type {
  BlendBlockFacts,
  BlendBlockFactsResult,
  BlendProposalStatus,
  BlendProposalVersionSummary,
  SavedBlendProposal,
  BlendMarketHistory,
  BlendMarketHistoryResult,
} from '../blocking/types';
import { fetchBlendBlockFacts, fetchBlendMarketHistory } from '../blocking/actions';
// PERF-4: composeBlendPdfFilename is jspdf-free (pure filename helper) and is used
// synchronously for the live preview / validity, so it stays a static import. The
// heavy downloadBlendPdf (jsPDF + jspdf-autotable) is loaded lazily on the Download
// click via `await import('./blend-proposal-pdf')` so those libs ship in a separate
// chunk instead of the main bundle.
import { composeBlendPdfFilename } from './blend-proposal-filename';
import type { BlendProposal, BlendProposalBlock } from '../blocking/actions';
// ── The ANALYSIS PAGES (2026-09-21) ──
// The owner's extra pages: price groups, quality and age. The payload is ONE read
// (`fetchBlendAnalysis`), the words and formats are shared with the printout through
// `blend-analysis-text.ts`, and which pages exist is a per-user preference.
import {
  analysisPages,
  analysisPagesLabel,
  includedPageCount,
  DEFAULT_BLEND_ANALYSIS_OPTIONS,
  parseBlendAnalysisOptions,
  serializeBlendAnalysisOptions,
  wantsAnalysis,
  BLEND_ANALYSIS_SETTINGS_MODULE,
  type BlendAnalysisOptions,
} from './blend-analysis-options';
// ── THE YARD MAP SHEET (2026-09-23) ──
// The owner: *"I'd also like to see a blocking view in the print of blend proposals,
// similar to the ones we made for the lens prints."* It IS the lens map — the geometry,
// the fit, the paper palette and the ink all come from `blocking/lens/lens-yard-map-model`
// through this module, which only decides which band each block is in and emits the HTML.
import {
  BLEND_PRINT_MARGIN_MM,
  BLEND_YARD_MAP_PRINT_CSS,
  buildBlendYardMapModel,
  buildBlendYardMapPage,
  type BlendYardMapModel,
} from './blend-yard-map-print';
import {
  BlendAnalysisIncludePopover,
  BlendAnalysisSections,
} from './blend-analysis-sections';
import {
  BLEND_ANALYSIS_PRINT_CSS,
  buildBlendAnalysisPages,
} from './blend-analysis-print';
import { useBlendAnalysis, type BlendAnalysisAdapter } from './use-blend-analysis';
// ── PAGE ONE'S MARKET CHART (2026-09-26) ──
// Twelve months of fed / deliveries price and volume under the lab stats. One model,
// two documents: the HTML printout draws its SVG, the jsPDF file walks the same layout.
import {
  BLEND_MARKET_CHART_PRINT_CSS,
  BLEND_MARKET_LOADING_REASON,
  blendMarketPlotHeightPx,
  buildBlendMarketChartModel,
  buildBlendMarketSlotHtml,
  type BlendMarketChartSlot,
} from './blend-market-chart';

/** The page-one market read's lifecycle. `loading` and `error` both print a note, never fail. */
type BlendMarketRead =
  | { status: 'loading' }
  | { status: 'ready'; history: BlendMarketHistory }
  | { status: 'error'; message: string };
import { useModuleSettings, lensSettingsModule } from '../blocking/lens/use-lens-settings';
import {
  DEFAULT_PRICE_LENS_SETTINGS,
  manualRoundedUpPhp,
  parsePriceLensSettings,
  PRICE_LENS_ID,
  serializePriceLensSettings,
} from '../blocking/lens/price-lens-settings';
import {
  AGE_LENS_ID,
  DEFAULT_AGE_LENS_SETTINGS,
  parseAgeLensSettings,
  serializeAgeLensSettings,
} from '../blocking/lens/age-lens-settings';
import { useTableSettings } from '@/components/providers/table-settings';

// ─── Display helpers ──────────────────────────────────────────────────────────

/** Lab stat formatting matches the print/detail view: BD → 3 decimals, rest → 2. */
function formatLab(key: string, value: number): string {
  return key === 'bd_astm' || key === 'bd_jis' ? value.toFixed(3) : value.toFixed(2);
}

function formatKg(val: number): string {
  return Math.round(val).toLocaleString();
}

/** Peso, 2 decimals, accounting-friendly (on-screen — no symbol prefix). */
function pesoNum(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The 7 lab stats in canonical column order, with display labels. `key` indexes BOTH
 * `BlendProposal['weighted']` (the blended summary) and `BlendProposalBlock` (per-block),
 * so the same order drives the weighted strip and the per-block table columns.
 */
const LAB_ORDER: { key: keyof BlendProposal['weighted']; label: string }[] = [
  { key: 'mc', label: 'MC' },
  { key: 'ash', label: 'ASH' },
  { key: 'bd_astm', label: 'BD ASTM' },
  { key: 'bd_jis', label: 'BD JIS' },
  { key: 'grit', label: 'GRIT' },
  { key: 'vm', label: 'VM' },
  { key: 'fc', label: 'FC' },
];

// ─── Print document ───────────────────────────────────────────────────────────
// Mirrors the detail-panel printout: a fully self-contained HTML document (its OWN
// `<html>` + shared `PRINT_CSS`) printed in a hidden iframe — never the live DOM — so it
// is immune to dark mode, Tailwind, the Dialog portal/overlay, transforms, and fixed
// positioning. Shared plumbing (escapeHtml/peso/printViaIframe/PRINT_CSS) lives in
// `./print-utils`; only this builder is specific to the blend proposal.
//
// Price gating: the per-block PHP/KG column, raw price, and product cost are emitted ONLY
// when the EFFECTIVE flag is true — `proposal.can_view_prices` (server gate) AND the
// `showPricesPref` display preference AND the value is non-null. No role lookup here;
// relies solely on the payload flag ANDed with the passed-in preference. The per-block lab
// columns are NOT gated — everyone prints lab stats. `showPricesPref` defaults to `true`.

/**
 * What the PRINTOUT needs to say about a block beyond the blend itself.
 *
 * It is a plain record keyed by `batch_id` — the same payload the on-screen table
 * renders — passed in rather than fetched, so the document is a pure function of what
 * was on screen and the two can never disagree. Absent → the three columns print em
 * dashes, exactly as the screen does.
 */
export interface BlendPrintFacts {
  facts: Record<string, BlendBlockFacts>;
  /** `block_loc` → batch id, for the live what-if whose blocks carry none. */
  batchIdByLoc?: Record<string, string | null>;
  /**
   * The supplier/age read's PORT — the same adapter idiom the lens panels carry, at the
   * same tiny scale. The default IS the server action and is what production always
   * uses; it is injectable for exactly one reason, which is the one the lens fixtures
   * record: the gated dev rig has no session, so the real action can only ever refuse
   * there, and a table that can only be LOOKED at with every cell blank cannot be
   * reviewed for the green / orange / em-dash cases.
   */
  factsAdapter?: (
    batchIds: string[],
    asOf?: string,
  ) => Promise<BlendBlockFactsResult>;
  /** The day the picture describes — printed under the table when it is not today. */
  asOf?: string | null;
}

export function buildBlendPrintDocument(
  proposal: BlendProposal,
  showPricesPref = true,
  meta?: BlendDocMeta | null,
  blockFacts?: BlendPrintFacts | null,
  /**
   * The ANALYSIS SHEETS, already built by `buildBlendAnalysisPages` — one `<section
   * class="apage">` per chosen page, each starting on its own sheet AFTER this one.
   *
   * Passed in rather than built here for the same reason `blockFacts` is: the document
   * stays a pure function of what was on screen, so the print and the screen can never
   * describe different pages. Absent or empty → this document is byte-identical to
   * what it was before the analysis existed, including its `<style>` block.
   */
  analysisPagesHtml?: string | null,
  /**
   * The YARD MAP sheet, already built by `buildBlendYardMapPage` — one
   * `<section class="ymap">` that lands directly AFTER the Selected Blocks table and
   * BEFORE the analysis sheets, because it describes the block list rather than
   * analysing it.
   *
   * Passed in for the same reason `analysisPagesHtml` is: the document stays a pure
   * function of what was on screen. Absent or empty → this document is byte-identical to
   * what it was before the map existed, including its `<style>` block.
   */
  yardMapHtml?: string | null,
  /**
   * PAGE ONE'S MARKET CHART (2026-09-26), already built by `buildBlendMarketChartSection`
   * — the twelve-month fed / deliveries price and volume picture under the lab stats.
   *
   * When present, the head and the chart are wrapped in a fixed-height `.p1` flex column
   * so the chart takes EXACTLY what is left of page one and page one stays one page by
   * construction; the Selected Blocks table then starts on sheet two. Absent or empty →
   * this document is byte-identical to what it was before the chart existed.
   */
  marketChartHtml?: string | null,
): string {
  const showPrices = proposal.can_view_prices && showPricesPref && proposal.raw_price_per_kg !== null;

  // ── Summary rows ──
  const summaryRows: string[] = [
    `<div class="row"><dt>Total Balance</dt><dd>${formatKg(proposal.total_balance)} kg</dd></div>`,
    `<div class="row"><dt>Blocks</dt><dd>${proposal.block_count}</dd></div>`,
  ];

  // ── Weighted lab stats ──
  const labRows = LAB_ORDER.map(
    ({ key, label }) => `<div class="row"><dt>${label}</dt><dd>${formatLab(key, proposal.weighted[key])}</dd></div>`,
  ).join('');

  // ── Pricing section (gated) ──
  let pricingSection = '';
  if (showPrices && proposal.raw_price_per_kg !== null) {
    const priceRows: string[] = [
      `<div class="row"><dt>Raw blended price</dt><dd>${peso(proposal.raw_price_per_kg)} /kg</dd></div>`,
    ];
    let formula = '';
    if (proposal.product_cost_per_kg !== null) {
      priceRows.push(
        `<div class="row"><dt>Product cost</dt><dd>${peso(proposal.product_cost_per_kg)} /kg</dd></div>`,
      );
      const multiplier = (1 + proposal.production_loss_pct / 100).toFixed(2);
      formula = `<p class="formula">Raw blend ${peso(proposal.raw_price_per_kg)} &times; ${multiplier} (${proposal.production_loss_pct}% production loss) = ${peso(
        proposal.product_cost_per_kg,
      )} /kg product cost</p>`;
    }
    pricingSection = `
  <section>
    <h2>Pricing</h2>
    <dl>${priceRows.join('')}</dl>
    ${formula}
  </section>`;
  }

  // ── Selected blocks table ──
  // Block · Batch · SUPPLIER · OPENED · LAST PILED · Balance · 7 labs · [PHP/KG].
  // The supplier pill keeps its COLOUR on paper (`print-color-adjust: exact` is
  // already in PRINT_CSS): green = the whole block is that supplier, orange = mixed.
  // Printing it grey would throw away the one thing the column is for.
  const factsOf = (b: (typeof proposal.blocks)[number]): BlendBlockFacts | null => {
    if (!blockFacts) return null;
    const id = b.batch_id ?? blockFacts.batchIdByLoc?.[b.block_loc] ?? null;
    return (id && blockFacts.facts[id]) || null;
  };
  const supplierCell = (f: BlendBlockFacts | null): string => {
    if (!f || f.isSingleSupplier === null || f.dominantSupplierDisplay === null) {
      return `<td>${EMDASH}</td>`;
    }
    const cls = f.isSingleSupplier ? 'sup-all' : 'sup-some';
    const share =
      !f.isSingleSupplier && f.dominantSharePct !== null
        ? ` ${Math.round(f.dominantSharePct)}%`
        : '';
    return `<td><span class="${cls}">${escapeHtml(f.dominantSupplierDisplay)}${share}</span></td>`;
  };
  const dayCell = (v: number | null | undefined): string =>
    `<td class="num">${v === null || v === undefined ? EMDASH : `${Math.round(v)} d`}</td>`;

  const blockBody = proposal.blocks
    .map((b) => {
      const f = factsOf(b);
      const labCells = LAB_ORDER.map(
        ({ key }) => `<td class="num">${formatLab(key, b[key])}</td>`,
      ).join('');
      const priceCell = showPrices
        ? `<td class="num">${b.php_kg !== null ? peso(b.php_kg) : EMDASH}</td>`
        : '';
      return (
        `<tr>` +
        `<td>${escapeHtml(b.block_loc)}</td>` +
        `<td>${escapeHtml(b.batch_code)}</td>` +
        supplierCell(f) +
        dayCell(f?.daysSinceOpened) +
        dayCell(f?.daysSinceLastPiled) +
        `<td class="num">${formatKg(b.balance)}</td>` +
        labCells +
        priceCell +
        `</tr>`
      );
    })
    .join('');

  const labHeaders = LAB_ORDER.map(({ label }) => `<th class="num">${label}</th>`).join('');
  // tfoot spans: Block + Batch + Supplier + Opened + Last piled (5) under "Total",
  // then Balance, then 7 empty lab cells.
  const asOfLine = blockFacts?.asOf
    ? `<p class="asof">Supplier and age as of ${escapeHtml(blockFacts.asOf)}.</p>`
    : '';
  const blockTable = proposal.blocks.length
    ? `<table>` +
      `<thead><tr>` +
      `<th>Block</th><th>Batch</th><th>Supplier</th>` +
      `<th class="num">Opened</th><th class="num">Last piled</th>` +
      `<th class="num">Balance (kg)</th>` +
      labHeaders +
      (showPrices ? `<th class="num">PHP/KG</th>` : '') +
      `</tr></thead>` +
      `<tbody>${blockBody}</tbody>` +
      `<tfoot><tr>` +
      `<td colspan="5">Total</td>` +
      `<td class="num">${formatKg(proposal.total_balance)}</td>` +
      `<td colspan="${LAB_ORDER.length}"></td>` +
      (showPrices ? `<td></td>` : '') +
      `</tr></tfoot>` +
      `</table>${asOfLine}`
    : `<p class="empty">No blocks selected.</p>`;

  // A saved version prints under its OWN name; a live what-if keeps the generic one.
  const savedTitle = (meta?.title ?? '').trim();
  const title = savedTitle ? escapeHtml(savedTitle) : 'Blend Proposal';
  const docTitle = savedTitle ? `${escapeHtml(savedTitle)} ${EMDASH} Blend Proposal` : 'Blend Proposal';

  // `v3 · as proposed 2026-09-02` — the SNAPSHOT's date, never the print clock.
  const versionLine = blendVersionLine(meta);
  const subtitleParts = [
    `${proposal.block_count} block${proposal.block_count === 1 ? '' : 's'} &middot; ${formatKg(
      proposal.total_balance,
    )} kg combined balance`,
  ];
  if (versionLine) subtitleParts.unshift(escapeHtml(versionLine));
  const subtitle = subtitleParts.join(' &middot; ');

  const remark = (meta?.notes ?? '').trim();
  const remarkLine = remark ? `<p class="subtitle remark">${escapeHtml(remark)}</p>` : '';

  // The analysis sheets' CSS rides ONLY when there are analysis sheets, so a printout
  // with no extra pages is byte-identical to the pre-existing one. The map's CSS is
  // INDEPENDENT of it for the same reason in reverse: the map may be the ONLY extra sheet
  // a reader ticked, and it carries its own `break-before: page`.
  const analysisHtml = (analysisPagesHtml ?? '').trim();
  const analysisCss = analysisHtml === '' ? '' : BLEND_ANALYSIS_PRINT_CSS;
  const yardHtml = (yardMapHtml ?? '').trim();
  const yardCss = yardHtml === '' ? '' : BLEND_YARD_MAP_PRINT_CSS;
  const chartHtml = (marketChartHtml ?? '').trim();
  const chartCss = chartHtml === '' ? '' : BLEND_MARKET_CHART_PRINT_CSS;
  // With a chart, page one is a fixed-height column (`.p1`) whose last child is the chart.
  const p1Open = chartHtml === '' ? '' : '<div class="p1">\n';
  const p1Close = chartHtml === '' ? '' : `\n  ${chartHtml}\n</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${docTitle}</title>
<style>${PRINT_CSS}
  /* LANDSCAPE. The table is 15 columns wide once supplier + the two ages join it,
     and portrait A4 cannot hold that without shrinking the type below legibility.
     Padding is squeezed BEFORE the font, and the font floor is 7pt. */
  @page { size: A4 landscape; margin: ${BLEND_PRINT_MARGIN_MM}mm; }
  /* The HEAD BLOCKS are squeezed so the 24-block table still lands on ONE page:
     A4 landscape leaves ~190mm of height, the table needs ~95mm of it, and the
     three definition lists were eating nearly all of the rest in white space. */
  h1 { font-size: 15px; }
  .subtitle { margin-bottom: 8px; }
  h2 { margin: 8px 0 3px; padding-bottom: 2px; }
  .row { padding: 1px 0; }
  .formula { margin: 3px 0 0; font-size: 9px; }
  .doc-footer { margin-top: 8px; padding-top: 4px; }
  /* Padding is squeezed BEFORE the font, and the font floor is 7pt. */
  table { font-size: 8.5pt; }
  th, td { padding: 2px 3px; }
  th { font-size: 7pt; }
  .subtitle.remark { font-style: italic; color: #333; margin: -12px 0 16px; white-space: pre-wrap; }
  .asof { font-size: 8pt; color: #555; margin: 4px 0 0; }
  /* The page's own supplier vocabulary, on paper. print-color-adjust:exact is
     already set on body in PRINT_CSS, so these survive the printer colour pass. */
  .sup-all, .sup-some {
    display: inline-block; border-radius: 999px; padding: 0 4px;
    font-size: 7.5pt; font-weight: 700; white-space: nowrap;
  }
  .sup-all  { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
  .sup-some { background: #ffedd5; color: #9a3412; border: 1px solid #fdba74; }
${yardCss}${analysisCss}${chartCss}</style>
</head>
<body>
  ${p1Open}<h1>${title}</h1>
  <p class="subtitle">${subtitle}</p>
  ${remarkLine}

  <section>
    <h2>Summary</h2>
    <dl>${summaryRows.join('')}</dl>
  </section>

  <section>
    <h2>Blended Lab Stats (Weighted Avg)</h2>
    <dl>${labRows}</dl>
  </section>
${pricingSection}${p1Close}
  <section>
    <h2>Selected Blocks</h2>
    ${blockTable}
  </section>
${yardHtml}
${analysisHtml}
  <div class="doc-footer">Blackwood ${EMDASH} Blend proposal${
    meta?.versionNo != null ? ` v${meta.versionNo}` : ''
  } &middot; Printed ${escapeHtml(
    new Date().toLocaleString(),
  )}</div>
</body>
</html>`;
}

// ─── Status pill ──────────────────────────────────────────────────────────────
//
// Shared with the Proposals LIST dialog, so a proposal reads the same in both places.
// The lifecycle is deliberately small (`draft | planned | fed`) and carries no join to
// `rc_out` — `fed` is RECORDED INTENT, not a reconciled fact.

const STATUS_STYLE: Record<BlendProposalStatus, string> = {
  draft: 'bg-zinc-400/10 text-zinc-400 border-zinc-400/30',
  planned: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  fed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
};

const STATUS_LABEL: Record<BlendProposalStatus, string> = {
  draft: 'Draft',
  planned: 'Planned',
  fed: 'Fed',
};

export const BLEND_STATUSES: BlendProposalStatus[] = ['draft', 'planned', 'fed'];

export function BlendStatusPill({
  status,
  fedOn,
  className,
}: {
  status: BlendProposalStatus;
  fedOn?: string | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap',
        STATUS_STYLE[status] ?? STATUS_STYLE.draft,
        className,
      )}
      title={status === 'fed' && fedOn ? `Fed on ${fedOn}` : undefined}
    >
      {STATUS_LABEL[status] ?? status}
      {status === 'fed' && fedOn ? <span className="font-mono font-normal opacity-80">{fedOn}</span> : null}
    </span>
  );
}

// ─── Delta rendering ──────────────────────────────────────────────────────────
//
// DELIBERATELY NOT COLOUR-CODED green/red. "MC rose 1.5" is not good or bad — it is
// just different — and painting every rise green would quietly assert a judgement the
// data does not support. The SIGN carries the direction; colour is reserved for
// "unknown" (muted em dash) and "did not move" (muted zero).

function Delta({
  value,
  decimals = 2,
  grouped = false,
}: {
  value: number | null;
  decimals?: number;
  /** Thousands separators — on for kilograms, off for lab stats and ₱/kg. */
  grouped?: boolean;
}) {
  const text = formatSignedDelta(value, decimals, grouped);
  const isZeroOrUnknown = value === null || text === formatSignedDelta(0, decimals, grouped);
  return (
    <span
      className={cn('font-mono tabular-nums', isZeroOrUnknown ? 'text-muted-foreground' : 'text-foreground')}
      title={value === null ? 'Not comparable — one side has no value' : undefined}
    >
      {text}
    </span>
  );
}

// ─── Per-block table row ──────────────────────────────────────────────────────

// ─── Supplier dominance + the two block ages (2026-09-21) ────────────────────
//
// `fetchBlendBlockFacts` answers, per selected block: who filled it (GREEN when the
// whole block is one supplier, ORANGE with the DOMINANT name and share when it is
// mixed) and how long ago it was OPENED and LAST PILED ON.
//
// ── `isSingleSupplier` IS THE RULE. NEVER `suppliers.length`. ────────────────
// The flag is the same column the Blocking supplier search reads
// (`view_blocking_block_suppliers.supplier_count_in_block = 1`), and it is proven
// equal to it on every batch the grid shows. Re-deriving it from the array's length
// is how this table and that search would eventually disagree about a block — and
// `null` is a THIRD answer (nothing was delivered as of that date), which is neither
// green nor orange and renders as a plain em dash with no colour at all.
//
// ── KEYED BY `batch_id`, AND AS OF A DATE ───────────────────────────────────
// A block address is REUSED when a pile empties, so a saved version resolved by
// `block_loc` would describe DIFFERENT charcoal under the same address. A SAVED
// version therefore passes its own batch ids AND the Asia/Manila date it was written,
// so the picture is the one that was true then; the LIVE modal passes neither date
// (today) nor stored ids (the grid's current occupants, via `batchIdByLoc`).
//
// These columns carry NO money and are shown to EVERY role, Production included.

/** An ISO instant → its Asia/Manila calendar date, `yyyy-MM-dd`. */
function manilaDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // `en-CA` formats as YYYY-MM-DD, which is the shape the action expects.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(d);
}

/** `38 d`, or an em dash. NULL IS NEVER 0 — a block with no dated delivery is blank. */
function formatDays(v: number | null | undefined): string {
  return v === null || v === undefined ? EMDASH : `${Math.round(v)} d`;
}

/** The full split, for the pill's tooltip: `Llanto 71% · Ornales 29%`. */
function supplierSplitTitle(facts: BlendBlockFacts): string {
  return facts.suppliers
    .map((sh) => `${sh.display} ${sh.sharePct === null ? EMDASH : `${sh.sharePct.toFixed(1)}%`}`)
    .join(' · ');
}

function SupplierPill({ facts }: { facts: BlendBlockFacts | null }) {
  // No facts at all (an id the database does not know, or a refusal), or nothing
  // delivered as of the date: an em dash, and NO colour. `false` here would paint a
  // pile nobody has delivered into as MIXED.
  if (!facts || facts.isSingleSupplier === null || facts.dominantSupplierDisplay === null) {
    return <span className="text-muted-foreground">{EMDASH}</span>;
  }
  const single = facts.isSingleSupplier;
  return (
    <span
      title={supplierSplitTitle(facts)}
      className={cn(
        'inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 py-[1px] text-[9px] font-semibold',
        single
          ? // The `.spotlight-supplier-all` family: the whole block is theirs.
            'border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
          : // The `.spotlight-supplier-some` family: they share it.
            'border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-400',
      )}
    >
      <span className="truncate">{facts.dominantSupplierDisplay}</span>
      {!single && facts.dominantSharePct !== null && (
        <span className="font-mono tabular-nums">{Math.round(facts.dominantSharePct)}%</span>
      )}
    </span>
  );
}

function BlockRow({
  block,
  showPrices,
  onRemove,
  removeDisabled,
  changed,
  currentBatchCode,
  facts = null,
}: {
  block: BlendProposalBlock;
  showPrices: boolean;
  onRemove: (() => void) | undefined;
  removeDisabled: boolean;
  /** Compare mode: the block is held by a DIFFERENT batch today. */
  changed?: boolean;
  currentBatchCode?: string | null;
  /** Supplier dominance + the two ages, or null while they fill in / are unknown. */
  facts?: BlendBlockFacts | null;
}) {
  return (
    <tr className={cn('border-b border-border/50 last:border-0', changed && 'bg-amber-500/5')}>
      <td className="text-[10px] font-mono font-semibold text-foreground px-1.5 py-1 whitespace-nowrap">
        <span className="inline-flex items-center gap-1">
          {changed && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
              title={
                currentBatchCode
                  ? `A different batch holds this block today: ${currentBatchCode}`
                  : 'This block no longer holds the proposed batch'
              }
            />
          )}
          {block.block_loc}
        </span>
      </td>
      <td className="text-[10px] text-muted-foreground px-1.5 py-1 max-w-[160px] truncate" title={block.batch_code}>
        {block.batch_code}
      </td>
      {/* SUPPLIER — the page's existing vocabulary: green = all of it, orange =
          some of it with the dominant name. Widths are RESERVED on the header, so
          the table does not jump as these fill in. */}
      <td className="px-1.5 py-1 text-[10px]">
        <SupplierPill facts={facts} />
      </td>
      <td
        className="text-[10px] font-mono text-muted-foreground text-right px-1.5 py-1 whitespace-nowrap tabular-nums"
        title={facts?.firstDeliveryDate ?? undefined}
      >
        {formatDays(facts?.daysSinceOpened)}
      </td>
      <td
        className="text-[10px] font-mono text-muted-foreground text-right px-1.5 py-1 whitespace-nowrap tabular-nums"
        title={facts?.lastDeliveryDate ?? undefined}
      >
        {formatDays(facts?.daysSinceLastPiled)}
      </td>
      <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1 whitespace-nowrap">
        {formatKg(block.balance)} kg
      </td>
      {/* 7 per-block lab columns — NOT price-gated */}
      {LAB_ORDER.map(({ key }) => (
        <td key={key} className="text-[10px] font-mono text-foreground text-right px-1.5 py-1 whitespace-nowrap">
          {formatLab(key, block[key])}
        </td>
      ))}
      {showPrices && (
        <td className="text-[10px] font-mono text-foreground text-right px-1.5 py-1 whitespace-nowrap">
          {block.php_kg !== null ? (
            <span className="inline-flex w-full justify-between gap-1">
              <span className="text-muted-foreground">&#8369;</span>
              <span>{block.php_kg.toFixed(2)}</span>
            </span>
          ) : (
            EMDASH
          )}
        </td>
      )}
      {/* Remove control */}
      {onRemove && (
        <td className="px-1 py-1 w-[28px]">
          <button
            onClick={onRemove}
            disabled={removeDisabled}
            className="flex items-center justify-center w-5 h-5 rounded
                       text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10
                       transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            title={`Remove ${block.block_loc} from the blend`}
            aria-label={`Remove ${block.block_loc} from the blend`}
          >
            <X className="w-3 h-3" />
          </button>
        </td>
      )}
    </tr>
  );
}

// ─── Version rail ─────────────────────────────────────────────────────────────

/** A version whose contents were overwritten in place since it was first saved. */
function versionWasEdited(v: { revisionNo: number; revisedAt: string | null }): boolean {
  return v.revisionNo > 1 || !!v.revisedAt;
}

function VersionRail({
  versions,
  selected,
  onSelect,
  disabled,
}: {
  versions: BlendProposalVersionSummary[];
  selected: number;
  onSelect: (versionNo: number) => void;
  disabled: boolean;
}) {
  const chosen = versions.find((v) => v.versionNo === selected) ?? null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 overflow-x-auto pb-0.5" role="tablist" aria-label="Proposal versions">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0 pr-1">
          Versions
        </span>
        {versions.map((v) => {
          const active = v.versionNo === selected;
          return (
            <button
              key={v.versionNo}
              role="tab"
              aria-selected={active}
              disabled={disabled}
              onClick={() => onSelect(v.versionNo)}
              data-blend-version-chip={v.versionNo}
              className={cn(
                'inline-flex items-center gap-1 px-2 h-6 rounded-md border text-[10px] font-mono font-semibold shrink-0',
                'transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none',
                active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted text-muted-foreground border-border hover:bg-accent hover:text-foreground',
              )}
              title={
                (v.changeNote
                  ? `v${v.versionNo} — ${v.changeNote}`
                  : `v${v.versionNo}${v.isCurrent ? ' (current)' : ''}`) +
                (versionWasEdited(v) ? ` · contents edited ${blendComputedDate(v.revisedAt) || ''}` : '')
              }
            >
              v{v.versionNo}
              {versionWasEdited(v) && (
                <Pencil
                  data-blend-version-edited={v.versionNo}
                  className="w-2 h-2 opacity-70"
                  aria-label="contents edited since first saved"
                />
              )}
              {v.isCurrent && <Star className="w-2.5 h-2.5 fill-current" aria-label="current version" />}
            </button>
          );
        })}
      </div>
      {/* Why this version differs, who made it, when. */}
      <div className="text-[10px] text-muted-foreground leading-snug min-h-[14px]">
        {chosen ? (
          <>
            {chosen.changeNote ? (
              <span className="text-foreground">{chosen.changeNote}</span>
            ) : (
              <span className="italic">No change note</span>
            )}
            <span className="mx-1.5 text-border">|</span>
            {/* THE as-of date of a version is `asOfAt` = coalesce(revised_at, created_at):
                an in-place overwrite recomputes the snapshot on the day it happens. */}
            <span className="font-mono">{blendComputedDate(chosen.asOfAt) || EMDASH}</span>
            {chosen.createdByName && <span> &middot; {chosen.createdByName}</span>}
            {versionWasEdited(chosen) && (
              <span
                data-blend-version-edited-line
                className="italic"
                title={`First saved ${blendComputedDate(chosen.createdAt) || EMDASH}${
                  chosen.createdByName ? ` by ${chosen.createdByName}` : ''
                }; contents replaced in place since (the earlier contents are archived).`}
              >
                {' '}
                &middot; edited {blendComputedDate(chosen.revisedAt) || EMDASH}
                {chosen.revisedByName ? ` by ${chosen.revisedByName}` : ''}
              </span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Header edit popover (title / remark / status) ────────────────────────────

interface HeaderPatch {
  title: string;
  notes: string | null;
  status: BlendProposalStatus;
  fed_on: string | null;
}

function HeaderEditPopover({
  title,
  notes,
  status,
  fedOn,
  busy,
  onSave,
}: {
  title: string;
  notes: string | null;
  status: BlendProposalStatus;
  fedOn: string | null;
  busy: boolean;
  onSave: (patch: HeaderPatch) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const [draftNotes, setDraftNotes] = useState(notes ?? '');
  const [draftStatus, setDraftStatus] = useState<BlendProposalStatus>(status);
  const [draftFedOn, setDraftFedOn] = useState(fedOn ?? '');

  // Re-seed every time the popover OPENS so it can never show a stale header. This is
  // an event handler, not an effect: opening is a user action, and resetting form state
  // from an effect would cascade a second render for no reason.
  function handleOpenChange(next: boolean) {
    if (next) {
      setDraftTitle(title);
      setDraftNotes(notes ?? '');
      setDraftStatus(status);
      setDraftFedOn(fedOn ?? '');
    }
    setOpen(next);
  }

  const titleValid = draftTitle.trim().length > 0;
  // The DB CHECK ties `status = 'fed'` to a non-null `fed_on` — refuse locally rather
  // than sending a write the database will bounce.
  const fedValid = draftStatus !== 'fed' || draftFedOn.trim().length > 0;
  const valid = titleValid && fedValid && !busy;

  async function submit() {
    if (!valid) return;
    const ok = await onSave({
      title: draftTitle.trim(),
      notes: draftNotes.trim() ? draftNotes.trim() : null,
      status: draftStatus,
      fed_on: draftStatus === 'fed' ? draftFedOn.trim() : null,
    });
    if (ok) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                     text-muted-foreground hover:text-foreground hover:bg-muted
                     transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
          title="Edit title, remark and status"
          aria-label="Edit proposal title, remark and status"
          disabled={busy}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 bg-popover/95 backdrop-blur-lg p-3">
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-foreground">Edit proposal</div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Title</label>
            <Input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="h-8 text-xs"
              aria-label="Proposal title"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Remark</label>
            <Textarea
              value={draftNotes}
              onChange={(e) => setDraftNotes(e.target.value)}
              rows={2}
              placeholder="Why this blend?"
              className="text-xs min-h-[48px] resize-none"
              aria-label="Proposal remark"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Status</label>
            <div className="flex items-center gap-1">
              {BLEND_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setDraftStatus(s)}
                  aria-pressed={draftStatus === s}
                  className={cn(
                    'flex-1 h-7 rounded-md border text-[10px] font-semibold transition-all duration-150 cursor-pointer',
                    draftStatus === s
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-muted text-muted-foreground border-border hover:bg-accent hover:text-foreground',
                  )}
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>

          {draftStatus === 'fed' && (
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Fed on</label>
              <Input
                type="date"
                value={draftFedOn}
                onChange={(e) => setDraftFedOn(e.target.value)}
                className="h-8 text-xs font-mono"
                aria-label="Fed on date"
              />
              <p className="text-[10px] text-muted-foreground leading-snug">
                Recorded intent only &mdash; nothing is reconciled against actual feeding.
              </p>
            </div>
          )}

          <div className="flex items-center justify-end gap-1.5 pt-0.5">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" className="h-7 text-xs" disabled={!valid} onClick={submit}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Save-as-new popover (title + remark, the first save of a fresh blend) ─────

export function SaveNewPopover({
  defaultTitle,
  busy,
  onSave,
  label = 'Save',
  triggerTitle = 'Save this blend as a proposal',
}: {
  defaultTitle?: string;
  busy: boolean;
  onSave: (input: { title: string; notes: string }) => Promise<boolean>;
  label?: string;
  triggerTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [notes, setNotes] = useState('');

  // Seeded on OPEN (an event), never from an effect — see HeaderEditPopover above.
  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle(defaultTitle ?? '');
      setNotes('');
    }
    setOpen(next);
  }

  const valid = title.trim().length > 0 && !busy;

  async function submit() {
    if (!valid) return;
    const ok = await onSave({ title: title.trim(), notes: notes.trim() });
    if (ok) setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          disabled={busy}
          data-blend-save-trigger
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-primary bg-primary
                     text-primary-foreground text-[11px] font-semibold
                     transition-all duration-150 cursor-pointer hover:bg-primary/90
                     disabled:opacity-40 disabled:pointer-events-none"
          title={triggerTitle}
          aria-label={triggerTitle}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 bg-popover/95 backdrop-blur-lg p-3">
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-foreground">Save proposal</div>
          <p className="text-[11px] text-muted-foreground leading-snug">
            Every proposal carries a title and a remark. The blend is stored exactly as the database computes it right
            now, so this version always says what the yard actually looked like today.
          </p>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="e.g. 4x8 RUN — week 36"
              className="h-8 text-xs"
              aria-label="Proposal title"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Remark</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Why this blend? (optional)"
              className="text-xs min-h-[48px] resize-none"
              aria-label="Proposal remark"
            />
          </div>

          <div className="flex items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" className="h-7 text-xs" disabled={!valid} onClick={submit}>
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Everything the dialog needs to render a SAVED version rather than a live what-if.
 * `null`/absent = the existing fresh-blend behaviour, unchanged.
 */
export interface BlendSavedContext {
  /** The version currently on screen (already price-gated by the server action). */
  proposal: SavedBlendProposal;
  /** Every version of this proposal — the rail. */
  versions: BlendProposalVersionSummary[];
  /** The proposal's newest version — ALSO the compare-and-set token for saving. */
  currentVersionNo: number;
  status: BlendProposalStatus;
  fedOn: string | null;
  isArchived: boolean;
  /** A version fetch / header write is in flight. */
  busy: boolean;
  onSelectVersion: (versionNo: number) => void;
  onModify: () => void;
  onCompare: () => void;
  onCloseCompare: () => void;
  /** Non-null while "Compare with today" is showing. */
  comparison: BlendComparison | null;
  compareLoading: boolean;
  onSaveHeader: (patch: HeaderPatch) => Promise<boolean>;
  onArchiveToggle: () => void;
}

interface BlendProposalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The computed proposal; null while loading or before first build. */
  proposal: BlendProposal | null;
  loading: boolean;
  /**
   * Remove a block from the blend (by block_loc). The grid owns the source-of-truth
   * selection Set and re-runs `buildBlendProposal` for the reduced set, so the modal
   * numbers and the grid cell rings stay in sync. Optional — omitting it hides the
   * per-row remove control (read-only proposal). IGNORED in saved mode: a stored
   * version is immutable, and editing its block list goes through Modify.
   */
  onRemoveBlock?: (blockLoc: string) => void;
  /**
   * Client-side display preference from the Blocking "Prices" toggle — a HIDE-ONLY layer
   * on top of the server gate. Effective price visibility is `proposal.can_view_prices &&
   * showPrices`, so this can hide prices but never reveal them. Defaults to `true` (shown)
   * for callers that don't pass it.
   */
  showPrices?: boolean;
  /**
   * `block_loc` → the batch occupying it RIGHT NOW, from the grid's own map.
   *
   * The live what-if's `BlendProposalBlock` carries no `batch_id` (only a SAVED
   * version's snapshot records one), and `fetchBlendBlockFacts` is keyed by batch —
   * never by block address, which is reused when a pile empties. So the live caller
   * supplies the ids and a saved version uses its own. Omitted → the supplier and age
   * columns render em dashes, which is the honest answer to "which batch is that?".
   */
  batchIdByLoc?: Record<string, string | null>;
  /**
   * Every `block_loc` the yard holds a pile in RIGHT NOW — the grid's own payload.
   *
   * The printed YARD MAP draws today's occupancy in grey behind the blend's own blocks,
   * so it needs the WHOLE yard, not just the selection. It is a separate prop from
   * `batchIdByLoc` on purpose: that one answers "which batch is in this block" for the
   * blocks of the BLEND, and a caller may legitimately supply it for the selection alone.
   * Omitted → the map still draws (the selection filled, every other slot empty), which
   * is the honest answer to "what else is in the yard?" when nobody said.
   */
  occupiedLocs?: readonly string[];
  /**
   * The supplier/age read's PORT — the same adapter idiom the lens panels carry, at the
   * same tiny scale. The default IS the server action and is what production always
   * uses; it is injectable for exactly one reason, which is the one the lens fixtures
   * record: the gated dev rig has no session, so the real action can only ever refuse
   * there, and a table that can only be LOOKED at with every cell blank cannot be
   * reviewed for the green / orange / em-dash cases.
   */
  factsAdapter?: (
    batchIds: string[],
    asOf?: string,
  ) => Promise<BlendBlockFactsResult>;
  /**
   * The ANALYSIS read's PORT — same adapter idiom, same one reason for existing as
   * `factsAdapter`: the gated dev rig has no session, so the real action can only ever
   * refuse there, and pages that can only be LOOKED at in their refusal state cannot be
   * reviewed for layout, colour or wording.
   */
  analysisAdapter?: BlendAnalysisAdapter;
  /**
   * The page-one MARKET CHART read's PORT (2026-09-26) — same adapter idiom, same one
   * reason for existing as `factsAdapter`. The default is `fetchBlendMarketHistory`.
   */
  marketAdapter?: (asOf?: string) => Promise<BlendMarketHistoryResult>;
  /** Present → the dialog renders a SAVED version (history mode). */
  saved?: BlendSavedContext | null;
  /** Fresh mode only: save this blend as a brand-new proposal. */
  onSaveNew?: (input: { title: string; notes: string }) => Promise<boolean>;
  /** A save is in flight. */
  saving?: boolean;
}

/**
 * Centered modal (Dialog) result panel for the Blocking "Blend Proposal" mode. Shows the
 * selected blocks (with per-block balance, full lab results, and price), the
 * balance-weighted lab blend, the combined balance + block count, and (price-gated) the
 * raw blended ₱/kg plus the yield-adjusted product cost with the formula spelled out.
 *
 * TWO MODES, ONE COMPONENT. Without `saved` it is the live what-if it has always been.
 * With `saved` it renders a stored version — the same shape, because
 * `fetchBlendProposalVersion` returns exactly `BlendProposal` plus identity, so the
 * summary strip, the lab table, Print and PDF all work with no new code. What history
 * mode ADDS is a version rail, the title + remark as the header, and the Modify /
 * Compare / Edit / Archive actions. What it REMOVES is the per-row X: a saved version is
 * immutable, and changing its blocks is what Modify is for.
 *
 * Price gating: prices render ONLY when the EFFECTIVE flag is true — i.e.
 * `proposal.can_view_prices` (server gate, NEVER weakened) AND the `showPrices` display
 * preference AND the relevant value is non-null. The backend nulls all ₱ fields
 * server-side for Production users, so this component does NO role lookup — it relies
 * solely on the `can_view_prices` flag (ANDed with the display preference) + null checks.
 * The same effective flag gates the printed document AND the downloaded PDF. The per-block
 * lab columns are NOT gated.
 *
 * MOBILE (below `sm`): read-only. Blend Proposal selection mode is desktop-only, so
 * Save / Modify / Edit / Archive are hidden rather than offered and then refused, and a
 * one-line note says so. Viewing, comparing, printing and PDF all work.
 */
export function BlendProposalDialog({
  open,
  onOpenChange,
  proposal,
  loading,
  onRemoveBlock,
  showPrices: showPricesPref = true,
  batchIdByLoc,
  occupiedLocs,
  factsAdapter,
  analysisAdapter,
  marketAdapter,
  saved = null,
  onSaveNew,
  saving = false,
}: BlendProposalDialogProps) {
  // EFFECTIVE visibility = server gate AND the client display preference. Hide-only:
  // `showPricesPref` can flip this off but can never turn the server gate back on.
  const showPrices = !!proposal?.can_view_prices && showPricesPref;

  // A saved version is immutable — the in-modal remove is disabled there by construction.
  const removeBlock = saved ? undefined : onRemoveBlock;

  // Identity for the printout / PDF. Absent in fresh mode → the documents render exactly
  // as they did before this feature existed.
  const docMeta: BlendDocMeta | null = saved
    ? {
        title: saved.proposal.title,
        notes: saved.proposal.notes,
        versionNo: saved.proposal.version_no,
        computedAt: saved.proposal.computed_at,
      }
    : null;

  const comparison = saved?.comparison ?? null;
  const changedLocs = new Set(comparison?.changedBlockLocs ?? []);
  const currentCodeByLoc = new Map(
    (comparison?.blocks ?? []).map((b) => [b.block_loc, b.currentBatchCode] as const),
  );

  // ── Supplier dominance + the two ages, per selected block ──
  //
  // ONE read per open / per version switch, race-safe on the request's own signature
  // (the same discipline the lens panels use): a reply is applied only while it is
  // still the one wanted, so a fast switch between versions cannot leave the previous
  // version's suppliers on screen. The table renders IMMEDIATELY with em dashes in
  // reserved-width columns and the figures fill in — no layout jump.
  // THE as-of instant of a saved version is the view's `as_of_at` =
  // coalesce(revised_at, created_at): an in-place overwrite recomputes the snapshot on
  // the day it happens, so `createdAt` alone would ask about the wrong day.
  const savedVersionAsOfAt = saved
    ? saved.versions.find((v) => v.versionNo === saved.proposal.version_no)?.asOfAt ?? null
    : null;
  /** A SAVED version asks about the day it was (last) written; the live modal asks about today. */
  const factsAsOf = manilaDate(savedVersionAsOfAt);

  const batchIds = useMemo(() => {
    if (!proposal) return [] as string[];
    const out: string[] = [];
    for (const b of proposal.blocks) {
      const id = b.batch_id ?? batchIdByLoc?.[b.block_loc] ?? null;
      if (id) out.push(id);
    }
    return out;
  }, [proposal, batchIdByLoc]);
  const idsKey = batchIds.join(',');

  const [facts, setFacts] = useState<Record<string, BlendBlockFacts>>({});
  const [factsAsOfUsed, setFactsAsOfUsed] = useState<string | null>(null);
  const factsWantRef = useRef('');

  useEffect(() => {
    if (!open || idsKey === '') {
      setFacts({});
      setFactsAsOfUsed(null);
      return;
    }
    const signature = `${idsKey}|${factsAsOf ?? ''}`;
    factsWantRef.current = signature;
    void (factsAdapter ?? fetchBlendBlockFacts)(idsKey.split(','), factsAsOf ?? undefined)
      .then((res) => {
        if (factsWantRef.current !== signature) return;
        if (res.ok) {
          setFacts(res.facts);
          setFactsAsOfUsed(res.asOf);
          return;
        }
        // These three columns are ADDITIVE CONTEXT. A refusal leaves them as em
        // dashes and never fails the modal, the print or the PDF — the blend itself
        // is unaffected by whether we could say who filled a block.
        setFacts({});
        setFactsAsOfUsed(null);
      })
      .catch(() => {
        if (factsWantRef.current !== signature) return;
        setFacts({});
        setFactsAsOfUsed(null);
      });
    // `factsAdapter` is deliberately NOT a dependency: it is the live action in
    // production and a module-stable stub in the fixture, and depending on an inline
    // arrow would re-fire this read on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, idsKey, factsAsOf]);

  // ── THE ANALYSIS PAGES ──
  //
  // Three preferences, all read through the SAME door (`user_table_settings`, via
  // `useModuleSettings`) and all read-only here except the first:
  //   • which pages to include — this dialog's own document;
  //   • the PRICE lens's cut lines, band names and market basis;
  //   • the AGE lens's cut lines and band names.
  // The two lens documents are borrowed rather than copied so a band a reader named
  // "Cheap stock" on the grid is called "Cheap stock" on the printed page too — one
  // definition of a band's label, exactly as `priceBandLabel` / `ageBandLabel` are one
  // definition of its wording.
  const { settings: analysisOptions, patch: patchAnalysisOptions } =
    useModuleSettings<BlendAnalysisOptions>(
      BLEND_ANALYSIS_SETTINGS_MODULE,
      DEFAULT_BLEND_ANALYSIS_OPTIONS,
      parseBlendAnalysisOptions,
      serializeBlendAnalysisOptions,
    );
  const { settings: priceLensSettings } = useModuleSettings(
    lensSettingsModule(PRICE_LENS_ID),
    DEFAULT_PRICE_LENS_SETTINGS,
    parsePriceLensSettings,
    serializePriceLensSettings,
  );
  const { settings: ageLensSettings } = useModuleSettings(
    lensSettingsModule(AGE_LENS_ID),
    DEFAULT_AGE_LENS_SETTINGS,
    parseAgeLensSettings,
    serializeAgeLensSettings,
  );
  // The reader's own WET / ASHY thresholds — the same document the grid cells read.
  const { settings: tableSettings } = useTableSettings();
  const labHighlights = tableSettings.labHighlights;

  const analysisPageIds = analysisPages(analysisOptions, showPrices);
  /**
   * The map is coloured by PRICE GROUP only when that page is actually in the document.
   * A legend describing a grouping the reader switched off would be a legend with no
   * table; with it off (or for a price-denied reader) the map falls to one accent.
   */
  const priceGroupsOn = analysisPageIds.includes('price');
  /** THE `+N` on the Print button — the analysis sheets PLUS the yard map. */
  const printPageCount = includedPageCount(analysisOptions, showPrices);

  /**
   * A TYPED market price is the cut line itself, so the `manual` basis sends
   * `Math.ceil(typed)` and every MEASURED basis sends nothing — which leaves the
   * database to compare the blend with the market of the month it BELONGS to (the
   * month a saved version was saved in, not today's). That is the whole point of an
   * as-of, and it is the price lens's own rule, not a second one.
   */
  const analysisMarketPhpKg =
    priceLensSettings.basis === 'manual' ? priceLensSettings.manualPrice : null;
  const analysisRoundedUpPhp =
    priceLensSettings.basis === 'manual' ? manualRoundedUpPhp(priceLensSettings.manualPrice) : null;

  const analysisBlockLocs = useMemo(
    () => (proposal ? proposal.blocks.map((b) => b.block_loc) : []),
    [proposal],
  );
  const analysisLocsKey = analysisBlockLocs.join('|');
  const savedProposalId = saved?.proposal.proposal_id ?? null;
  const savedVersionNo = saved?.proposal.version_no ?? null;
  const analysisSource = useMemo(() => {
    if (savedProposalId !== null && savedVersionNo !== null) {
      // A SAVED version reads its STORED snapshot verbatim and dates its ages from the
      // day it was written.
      return { kind: 'saved' as const, proposalId: savedProposalId, versionNo: savedVersionNo };
    }
    if (analysisLocsKey === '') return null;
    return { kind: 'live' as const, blockLocs: analysisLocsKey.split('|') };
  }, [savedProposalId, savedVersionNo, analysisLocsKey]);

  const {
    analysis,
    loading: analysisLoading,
    refusal: analysisRefusal,
    stalled: analysisStalled,
    retry: retryAnalysis,
  } = useBlendAnalysis({
    enabled: open && !!proposal && wantsAnalysis(analysisOptions, showPrices),
    source: analysisSource,
    priceEdgeOffsets: priceLensSettings.edgeOffsets,
    ageEdgeDays: ageLensSettings.edgeDays,
    marketPhpKg: analysisMarketPhpKg,
    roundedUpPhp: analysisRoundedUpPhp,
    adapter: analysisAdapter,
  });

  /** The chosen sheets, for the printout AND the PDF — one build, two documents. */
  const analysisPagesHtml = useMemo(
    () =>
      buildBlendAnalysisPages({
        analysis,
        options: analysisOptions,
        canViewPrices: showPrices,
        priceBandNames: priceLensSettings.bandNames,
        ageBandNames: ageLensSettings.bandNames,
        labHighlights,
      }),
    [
      analysis,
      analysisOptions,
      showPrices,
      priceLensSettings.bandNames,
      ageLensSettings.bandNames,
      labHighlights,
    ],
  );

  // ── THE YARD MAP SHEET ──
  //
  // ONE model, TWO documents (the HTML iframe printout and the jsPDF file), for the same
  // reason `analysisPagesHtml` is built once: two builds of the same map could describe
  // different yards. The occupancy is the LIVE grid's; the selection is the proposal's
  // own; the caption says which is which, because a saved version's blocks are a
  // statement about the day it was written while the yard is today's.
  const yardMap: BlendYardMapModel | null = useMemo(() => {
    if (!proposal || !analysisOptions.yardMap) return null;
    return buildBlendYardMapModel({
      occupiedLocs: occupiedLocs ?? [],
      selectedLocs: proposal.blocks.map((b) => b.block_loc),
      analysis,
      priceGroupsOn,
      asSavedDate: saved ? blendComputedDate(saved.proposal.computed_at) : null,
    });
  }, [proposal, analysisOptions.yardMap, occupiedLocs, analysis, priceGroupsOn, saved]);

  const yardMapHtml = useMemo(
    () => (yardMap ? buildBlendYardMapPage(yardMap) : ''),
    [yardMap],
  );

  // ── PAGE ONE'S MARKET CHART ──
  //
  // ONE read per open / per version switch, guarded by its own SIGNATURE (the anchor
  // date) exactly like the facts read above. The window is the 12 months ending with the
  // blend's own as-of month: a saved version's `as_of_at` (Manila), the live what-if's
  // today. A refusal or failure NEVER fails the documents: the slot then prints a short
  // "market history unavailable" note in the chart's place (and a Print that beats the
  // reply prints a "still loading" note), so page one keeps its shape either way.
  const [marketRead, setMarketRead] = useState<BlendMarketRead>({ status: 'loading' });
  const marketWantRef = useRef('');
  const marketAnchor = saved ? factsAsOf : null;
  const hasProposal = !!proposal;
  useEffect(() => {
    if (!open || !hasProposal) {
      marketWantRef.current = '';
      return;
    }
    const signature = marketAnchor ?? 'today';
    marketWantRef.current = signature;
    setMarketRead({ status: 'loading' });
    void (marketAdapter ?? fetchBlendMarketHistory)(marketAnchor ?? undefined)
      .then((res) => {
        if (marketWantRef.current !== signature) return;
        setMarketRead(
          res.ok ? { status: 'ready', history: res.history } : { status: 'error', message: res.message },
        );
      })
      .catch((err: unknown) => {
        if (marketWantRef.current !== signature) return;
        setMarketRead({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    // `marketAdapter` deliberately NOT a dependency — same reason as `factsAdapter`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hasProposal, marketAnchor]);

  const marketSlot: BlendMarketChartSlot | null = useMemo(() => {
    if (!proposal) return null;
    if (marketRead.status === 'loading') {
      return { kind: 'unavailable', reason: BLEND_MARKET_LOADING_REASON };
    }
    if (marketRead.status === 'error') {
      return {
        kind: 'unavailable',
        reason: `${marketRead.message} The blend itself is unaffected.`,
      };
    }
    return {
      kind: 'chart',
      model: buildBlendMarketChartModel({
        history: marketRead.history,
        showPrices,
        blendRawPhpKg: proposal.raw_price_per_kg,
      }),
    };
  }, [marketRead, proposal, showPrices]);

  const remarkText = saved?.proposal.notes ?? '';
  const marketChartHtml = useMemo(() => {
    if (!marketSlot || !proposal) return '';
    return buildBlendMarketSlotHtml(
      marketSlot,
      blendMarketPlotHeightPx({
        hasPricing: showPrices && proposal.raw_price_per_kg !== null,
        remarkText,
        footnoteCount: marketSlot.kind === 'chart' ? marketSlot.model.footnotes.length : 0,
      }),
    );
  }, [marketSlot, proposal, showPrices, remarkText]);

  // ── Download PDF (label prompt) ──
  const [pdfPopoverOpen, setPdfPopoverOpen] = useState(false);
  const [pdfLabel, setPdfLabel] = useState('');
  // Live filename preview / validity — empty after sanitize means "require a label".
  const previewFilename = composeBlendPdfFilename(pdfLabel);
  const labelValid = previewFilename !== null;

  // A saved proposal already HAS a name; default the PDF label to it rather than making
  // the operator retype it. Seeded when the popover OPENS so an edit inside it still sticks.
  const defaultPdfLabel = saved?.proposal.title ?? '';
  function handlePdfPopoverOpenChange(next: boolean) {
    setPdfPopoverOpen(next);
    setPdfLabel(next ? defaultPdfLabel : '');
  }

  async function handleDownloadPdf() {
    if (!proposal || !labelValid) return;
    try {
      // Lazy-load jsPDF only when the user actually downloads (PERF-4).
      const { downloadBlendPdf } = await import('./blend-proposal-pdf');
      // Pass the display preference so a hidden-prices PDF carries NO ₱ (the PDF builder
      // re-ANDs it with the server `can_view_prices`).
      downloadBlendPdf(
        proposal,
        pdfLabel,
        showPricesPref,
        docMeta,
        {
          facts,
          batchIdByLoc,
          asOf: saved ? factsAsOfUsed : null,
        },
        // The SAME payload and the SAME chosen pages the screen and the printout use.
        {
          analysis,
          options: analysisOptions,
          canViewPrices: showPrices,
          priceBandNames: priceLensSettings.bandNames,
          ageBandNames: ageLensSettings.bandNames,
          labHighlights,
        },
        // The SAME map model the HTML printout draws, so the two cannot disagree.
        yardMap,
        // Page one's market chart (or its note) — the SAME slot the HTML printout draws.
        marketSlot,
      );
      handlePdfPopoverOpenChange(false);
    } catch (err) {
      errorToast('Failed to generate PDF', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handlePrint() {
    if (!proposal) return;
    try {
      // Pass the display preference so a hidden-prices printout carries NO ₱ (the builder
      // re-ANDs it with the server `can_view_prices`).
      const html = buildBlendPrintDocument(
        proposal,
        showPricesPref,
        docMeta,
        {
          facts,
          batchIdByLoc,
          // Only a SAVED version is describing a day other than today.
          asOf: saved ? factsAsOfUsed : null,
        },
        // One sheet per chosen analysis page, after this one. Empty when none is
        // ticked — the document is then byte-identical to the pre-analysis one.
        analysisPagesHtml,
        // The YARD MAP sheet, between the blocks table and the analysis sheets.
        yardMapHtml,
        // Page one's market chart, under the lab stats.
        marketChartHtml,
      );
      const ok = printViaIframe(html);
      if (!ok) {
        errorToast('Could not open the print view', {
          description:
            'The browser blocked creating the hidden print frame. Try again, or use your browser menu (File → Print).',
        });
      }
    } catch (err) {
      errorToast('Failed to print blend proposal', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Column count for the per-block table footer/colspans (Block, Batch, Balance, 7 labs,
  // [PHP/KG], [remove]).
  const labCols = LAB_ORDER.length;

  const headerTitle = saved ? saved.proposal.title : 'Blend Proposal';
  const metaLine = saved
    ? [
        blendVersionLine(docMeta),
        saved.proposal.created_by_name,
        // An overwritten version says so — its contents changed since it was first saved.
        saved.proposal.revision_no > 1 || saved.proposal.revised_at
          ? `edited ${blendComputedDate(saved.proposal.revised_at) || EMDASH}${
              saved.proposal.revised_by_name ? ` by ${saved.proposal.revised_by_name}` : ''
            }`
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="animate-modal-enter w-[calc(100%-2rem)] max-w-4xl sm:max-w-4xl max-h-[85dvh] p-0 gap-0 overflow-hidden flex flex-col"
      >
        {/* ── Header (actions + version rail live here; stays fixed while body scrolls) ── */}
        <DialogHeader className="shrink-0 bg-background/90 backdrop-blur-sm border-b border-border px-4 py-3 text-left gap-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2 min-w-0">
              <span className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/10 text-primary shrink-0 mt-0.5">
                <Calculator className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <DialogTitle className="text-sm truncate max-w-[420px]" title={headerTitle}>
                    {headerTitle}
                  </DialogTitle>
                  {saved && <BlendStatusPill status={saved.status} fedOn={saved.fedOn} />}
                  {saved?.isArchived && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-border bg-muted text-[10px] font-semibold text-muted-foreground">
                      <Archive className="w-2.5 h-2.5" />
                      Archived
                    </span>
                  )}
                </div>
                {/* The REMARK, in muted prose under the title. */}
                <DialogDescription className="text-xs">
                  {saved ? (
                    saved.proposal.notes ? (
                      <span className="line-clamp-2">{saved.proposal.notes}</span>
                    ) : (
                      <span className="italic opacity-70">No remark</span>
                    )
                  ) : (
                    <>
                      Weighted blend across{' '}
                      {proposal
                        ? `${proposal.block_count} block${proposal.block_count === 1 ? '' : 's'}`
                        : 'selected blocks'}
                    </>
                  )}
                </DialogDescription>
                {metaLine && <div className="text-[10px] font-mono text-muted-foreground mt-0.5">{metaLine}</div>}
              </div>
            </div>

            {/* Header actions */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* In-flight indicator while a remove / version load re-runs the blend */}
              {(loading || saved?.busy) && proposal && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-label="Updating blend" />
              )}

              {/* ── Save (fresh blend only; desktop only) ── */}
              {!saved && onSaveNew && (
                <span className="max-sm:hidden">
                  <SaveNewPopover busy={saving} onSave={onSaveNew} />
                </span>
              )}

              {/* ── Saved-mode actions ── */}
              {saved && (
                <>
                  {/* Compare is READ-ONLY, so it stays available on mobile too. */}
                  <button
                    onClick={comparison ? saved.onCloseCompare : saved.onCompare}
                    disabled={saved.compareLoading || !proposal}
                    aria-pressed={!!comparison}
                    data-blend-compare-toggle
                    className={cn(
                      'flex items-center justify-center w-7 h-7 rounded-md border transition-all duration-150 cursor-pointer',
                      'disabled:opacity-40 disabled:pointer-events-none',
                      comparison
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
                    )}
                    title={comparison ? 'Hide the comparison with today' : 'Compare this version with today'}
                    aria-label="Compare with today"
                  >
                    {saved.compareLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <GitCompare className="w-3.5 h-3.5" />
                    )}
                  </button>

                  <span className="max-sm:hidden flex items-center gap-1.5">
                    <button
                      onClick={saved.onModify}
                      disabled={saved.busy || saved.isArchived}
                      data-blend-modify
                      className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-border
                                 text-[11px] font-semibold text-muted-foreground
                                 hover:text-foreground hover:bg-muted transition-all duration-150 cursor-pointer
                                 disabled:opacity-40 disabled:pointer-events-none"
                      title={
                        saved.isArchived
                          ? 'Restore this proposal before modifying it'
                          : 'Re-select these blocks on the grid and save a new version'
                      }
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Modify
                    </button>

                    <HeaderEditPopover
                      title={saved.proposal.title}
                      notes={saved.proposal.notes}
                      status={saved.status}
                      fedOn={saved.fedOn}
                      busy={saved.busy}
                      onSave={saved.onSaveHeader}
                    />

                    <button
                      onClick={saved.onArchiveToggle}
                      disabled={saved.busy}
                      className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                                 text-muted-foreground hover:text-foreground hover:bg-muted
                                 transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                      title={saved.isArchived ? 'Restore this proposal' : 'Archive this proposal (never deleted)'}
                      aria-label={saved.isArchived ? 'Restore proposal' : 'Archive proposal'}
                    >
                      {saved.isArchived ? (
                        <ArchiveRestore className="w-3.5 h-3.5" />
                      ) : (
                        <Archive className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </span>
                </>
              )}

              {/* ── Analysis: which extra pages this proposal shows and prints ──
                     Read-only content, so it stays available on mobile like Compare. */}
              <BlendAnalysisIncludePopover
                options={analysisOptions}
                onChange={patchAnalysisOptions}
                canViewPrices={showPrices}
                pageCount={printPageCount}
              />

              {/* Download PDF — prompts for a label via a Popover, then saves YYMMDD - {label}.pdf */}
              <Popover open={pdfPopoverOpen} onOpenChange={handlePdfPopoverOpenChange}>
                <PopoverTrigger asChild>
                  <button
                    disabled={!proposal || loading}
                    className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                               text-muted-foreground hover:text-foreground hover:bg-muted
                               transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                    title="Download as PDF"
                    aria-label="Download blend proposal as PDF"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={8} className="w-72 bg-popover/95 backdrop-blur-lg p-3">
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-foreground">Download PDF</div>
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      Name this proposal. The file is saved as{' '}
                      <span className="font-mono text-foreground">YYMMDD - label.pdf</span>.
                    </p>
                    <Input
                      autoFocus
                      value={pdfLabel}
                      onChange={(e) => setPdfLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && labelValid) {
                          e.preventDefault();
                          handleDownloadPdf();
                        }
                      }}
                      placeholder="e.g. 4x8 RUN"
                      className="h-8 text-xs"
                      aria-label="PDF label"
                    />
                    {/* Live filename preview */}
                    <div className="text-[10px] font-mono text-muted-foreground truncate min-h-[14px]">
                      {labelValid ? previewFilename : <span className="italic">Enter a label to enable download</span>}
                    </div>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => handlePdfPopoverOpenChange(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-xs"
                        disabled={!labelValid}
                        onClick={handleDownloadPdf}
                      >
                        <Download className="w-3 h-3" />
                        Download
                      </Button>
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <button
                onClick={handlePrint}
                disabled={!proposal || loading}
                data-blend-print
                // Page one's market read — `loading | ready | error` — so a test (and a
                // curious reader in devtools) can tell which chart slot a Print will carry.
                data-blend-market-state={marketRead.status}
                className={cn(
                  `flex items-center justify-center h-7 rounded-md border border-border
                   text-muted-foreground hover:text-foreground hover:bg-muted
                   transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none`,
                  // The page count needs room, so the button widens rather than
                  // clipping — and it is only ever there when there is a count.
                  printPageCount > 0 ? 'gap-1 px-1.5' : 'w-7',
                )}
                // WHAT WILL COME OUT OF THE PRINTER, said before it does. A reader who
                // ticked three pages and got one sheet would have no way to tell
                // whether the pages or the printer were at fault.
                title={
                  printPageCount > 0
                    ? `Print blend proposal — the blocks sheet plus ${analysisPagesLabel(
                        printPageCount,
                      )}`
                    : 'Print blend proposal'
                }
                aria-label={
                  printPageCount > 0
                    ? `Print blend proposal (${analysisPagesLabel(printPageCount)})`
                    : 'Print blend proposal'
                }
              >
                <Printer className="w-3.5 h-3.5" />
                {printPageCount > 0 && (
                  <span className="font-mono text-[9px] font-semibold">+{printPageCount}</span>
                )}
              </button>
              <button
                onClick={() => onOpenChange(false)}
                className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                           text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer"
                title="Close"
                aria-label="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* ── Version rail (saved mode only) ── */}
          {saved && saved.versions.length > 0 && (
            <VersionRail
              versions={saved.versions}
              selected={saved.proposal.version_no}
              onSelect={saved.onSelectVersion}
              disabled={saved.busy}
            />
          )}

          {/* Mobile: say what is unavailable rather than silently omitting it. */}
          <p className="sm:hidden text-[10px] text-muted-foreground leading-snug">
            Read-only on a phone &mdash; saving and modifying a blend need the grid, which is desktop-only. Viewing,
            comparing and printing all work here.
          </p>
        </DialogHeader>

        {/* ── Body (scrolls internally) ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {!proposal ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* ── Compare banner ── */}
              {comparison && (
                <div className="rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                  <span className="text-[11px] text-foreground">
                    Comparing this version with the yard <span className="font-semibold">today</span>. The saved
                    numbers are never changed.
                    {comparison.changedBlockLocs.length > 0 && (
                      <span className="text-muted-foreground">
                        {' '}
                        {comparison.changedBlockLocs.length === 1
                          ? '1 block now holds a different batch.'
                          : `${comparison.changedBlockLocs.length} blocks now hold a different batch.`}
                      </span>
                    )}
                  </span>
                  <button
                    onClick={saved?.onCloseCompare}
                    className="text-[11px] text-muted-foreground hover:text-foreground transition-colors duration-150 cursor-pointer shrink-0"
                  >
                    Hide
                  </button>
                </div>
              )}

              {/* ── Totals ── */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">Total Balance</div>
                  <div className="text-sm font-bold font-mono text-foreground">
                    {formatKg(proposal.total_balance)}{' '}
                    <span className="text-xs font-normal text-muted-foreground">kg</span>
                  </div>
                  {comparison && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      today{' '}
                      <span className="font-mono text-foreground">
                        {comparison.totalBalance.after === null ? EMDASH : formatKg(comparison.totalBalance.after)}
                      </span>{' '}
                      <Delta value={comparison.totalBalance.delta} decimals={0} grouped />
                    </div>
                  )}
                </div>
                <div className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">Blocks</div>
                  <div className="text-sm font-bold font-mono text-foreground">{proposal.block_count}</div>
                  {comparison && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      today{' '}
                      <span className="font-mono text-foreground">{comparison.blockCount.after ?? EMDASH}</span>{' '}
                      <Delta value={comparison.blockCount.delta} decimals={0} />
                    </div>
                  )}
                </div>
              </div>

              {/* ── Weighted lab blend ── */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Blended Lab Stats (Weighted Avg)
                  {comparison && <span className="ml-1.5 font-normal normal-case">— saved / today / change</span>}
                </div>
                {/* Never crush, always scroll: each stat keeps an intrinsic minimum and the
                    STRIP scrolls when the viewport is narrower. Before this, a phone
                    rendered `10.…` / `0.4…` — a truncated lab number is worse than no
                    lab number, because it still looks like a reading. */}
                <div className="flex gap-1 overflow-x-auto pb-0.5">
                  {LAB_ORDER.map(({ key, label }) => {
                    const d = comparison?.weighted[key as BlendLabKey] ?? null;
                    const dp = blendLabDecimals(key as BlendLabKey);
                    return (
                      <div
                        key={key}
                        className={cn(
                          'flex-1 rounded-md border border-border px-1 py-1 text-center',
                          comparison ? 'min-w-[72px]' : 'min-w-[62px]',
                        )}
                      >
                        <div className="text-[8px] font-medium text-muted-foreground uppercase">{label}</div>
                        <div className="text-xs font-mono font-bold text-foreground whitespace-nowrap">
                          {formatLab(key, proposal.weighted[key])}
                        </div>
                        {d && (
                          <>
                            <div className="text-[9px] font-mono text-muted-foreground whitespace-nowrap">
                              {d.after === null ? EMDASH : d.after.toFixed(dp)}
                            </div>
                            <div className="text-[9px] whitespace-nowrap">
                              <Delta value={d.delta} decimals={dp} />
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* ── Pricing (role-gated) ── */}
              {showPrices && proposal.raw_price_per_kg !== null && (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2.5 space-y-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Pricing
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Raw blended price</span>
                    <span className="font-mono font-bold text-foreground inline-flex items-baseline gap-0.5">
                      <span className="text-muted-foreground font-normal">&#8369;</span>
                      {pesoNum(proposal.raw_price_per_kg)}
                      <span className="text-[10px] font-normal text-muted-foreground">/kg</span>
                    </span>
                  </div>
                  {comparison && (
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>today</span>
                      <span className="font-mono">
                        {comparison.rawPrice.after === null ? EMDASH : `₱${pesoNum(comparison.rawPrice.after)}`}
                        <span className="ml-1.5">
                          <Delta value={comparison.rawPrice.delta} decimals={2} />
                        </span>
                      </span>
                    </div>
                  )}

                  {proposal.product_cost_per_kg !== null && (
                    <>
                      <div className="flex items-center justify-between text-xs pt-1.5 border-t border-border">
                        <span className="text-foreground font-semibold">Product cost</span>
                        <span className="font-mono font-bold text-foreground inline-flex items-baseline gap-0.5">
                          <span className="text-muted-foreground font-normal">&#8369;</span>
                          {pesoNum(proposal.product_cost_per_kg)}
                          <span className="text-[10px] font-normal text-muted-foreground">/kg</span>
                        </span>
                      </div>
                      {comparison && (
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>today</span>
                          <span className="font-mono">
                            {comparison.productCost.after === null
                              ? EMDASH
                              : `₱${pesoNum(comparison.productCost.after)}`}
                            <span className="ml-1.5">
                              <Delta value={comparison.productCost.delta} decimals={2} />
                            </span>
                          </span>
                        </div>
                      )}
                      {/* Transparent formula */}
                      <div className="text-[10px] font-mono text-muted-foreground leading-relaxed bg-background/50 rounded px-2 py-1.5">
                        Raw blend &#8369;{pesoNum(proposal.raw_price_per_kg)} &times;{' '}
                        {(1 + proposal.production_loss_pct / 100).toFixed(2)} ({proposal.production_loss_pct}% production
                        loss) = &#8369;{pesoNum(proposal.product_cost_per_kg)} /kg product cost
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ── Selected blocks (Excel-dense; per-block lab columns) ── */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Selected Blocks
                </div>
                {/* Horizontal scroll if the wide lab table overflows — never shrink columns illegibly.
                    Dim + disable while a remove re-fetch is in flight so stale rows don't look interactive. */}
                <div
                  className={cn(
                    'rounded-md overflow-x-auto bg-muted border border-border transition-opacity duration-150',
                    loading && 'opacity-60 pointer-events-none',
                  )}
                >
                  {/* NEVER CRUSH, ALWAYS SCROLL: the min-width is the SUM of the
                      column minimums (640 as it was, + 120 supplier + 54 opened + 58
                      last-piled = 872), so the wrapper above scrolls instead of
                      squeezing a supplier name to nothing. The three new columns carry
                      EXPLICIT widths so the table does not jump when the facts land. */}
                  <table className="w-full min-w-[872px] border-collapse">
                    <thead>
                      <tr>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Block
                        </th>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Batch
                        </th>
                        <th
                          className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border whitespace-nowrap w-[120px]"
                          title="Green = the whole block is one supplier. Orange = mixed, showing the biggest."
                        >
                          Supplier
                        </th>
                        <th
                          className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap w-[54px]"
                          title="Days since the block's FIRST delivery"
                        >
                          Opened
                        </th>
                        <th
                          className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap w-[58px]"
                          title="Days since the block was last piled on"
                        >
                          Last piled
                        </th>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Balance
                        </th>
                        {LAB_ORDER.map(({ label }) => (
                          <th
                            key={label}
                            className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap"
                          >
                            {label}
                          </th>
                        ))}
                        {showPrices && (
                          <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-right px-1.5 py-1 border-b border-border whitespace-nowrap">
                            PHP/KG
                          </th>
                        )}
                        {removeBlock && <th className="w-[28px] border-b border-border" />}
                      </tr>
                    </thead>
                    <tbody>
                      {proposal.blocks.map((b) => (
                        <BlockRow
                          key={b.block_loc}
                          block={b}
                          showPrices={showPrices}
                          onRemove={removeBlock ? () => removeBlock(b.block_loc) : undefined}
                          removeDisabled={loading}
                          changed={changedLocs.has(b.block_loc)}
                          currentBatchCode={currentCodeByLoc.get(b.block_loc) ?? null}
                          facts={
                            // Keyed by BATCH, never by block address. An id the
                            // database does not know is ABSENT from `facts`, which
                            // renders as em dashes rather than as zero-filled figures.
                            facts[b.batch_id ?? batchIdByLoc?.[b.block_loc] ?? ''] ?? null
                          }
                        />
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-muted/50">
                        <td
                          className="text-[9px] font-semibold text-muted-foreground uppercase px-1.5 py-1 whitespace-nowrap"
                          colSpan={5}
                        >
                          Total
                        </td>
                        <td className="text-[10px] font-mono font-semibold text-foreground text-right px-1.5 py-1 whitespace-nowrap">
                          {formatKg(proposal.total_balance)} kg
                        </td>
                        {/* Empty cells under the lab columns */}
                        <td colSpan={labCols} />
                        {showPrices && <td />}
                        {removeBlock && <td />}
                      </tr>
                    </tfoot>
                  </table>
                </div>
                {/* THE AS-OF LINE. A saved version's supplier picture and ages are
                    RECONSTRUCTED as they stood on the day that version was written —
                    balances fall, block addresses are reused and lab averages move, so
                    saying which day it is describing is not decoration. The live modal
                    is "now" and says nothing. */}
                {saved && factsAsOfUsed && (
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    Supplier and age as of{' '}
                    <span className="font-mono text-foreground">{factsAsOfUsed}</span>
                  </p>
                )}
                {comparison && comparison.missingBlockLocs.length > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-1.5">
                    No longer on the grid:{' '}
                    <span className="font-mono text-foreground">{comparison.missingBlockLocs.join(', ')}</span>
                  </p>
                )}
              </div>

              {/* ── THE ANALYSIS PAGES ──
                     Sections in this same scroll, each with a heading that reads as a
                     page; the printout renders the identical payload as separate
                     SHEETS. Which ones are here is the reader's own Include-pages
                     choice, ANDed with the effective price flag. */}
              <BlendAnalysisSections
                analysis={analysis}
                options={analysisOptions}
                canViewPrices={showPrices}
                loading={analysisLoading}
                refusal={analysisRefusal}
                stalled={analysisStalled}
                onRetry={retryAnalysis}
                priceBandNames={priceLensSettings.bandNames}
                ageBandNames={ageLensSettings.bandNames}
                labHighlights={labHighlights}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
