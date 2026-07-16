'use client';

import { useState } from 'react';
import { Loader2, Calculator, Printer, X, Download } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { errorToast } from '@/lib/toast';
import { EMDASH, escapeHtml, peso, printViaIframe, PRINT_CSS } from './print-utils';
// PERF-4: composeBlendPdfFilename is jspdf-free (pure filename helper) and is used
// synchronously for the live preview / validity, so it stays a static import. The
// heavy downloadBlendPdf (jsPDF + jspdf-autotable) is loaded lazily on the Download
// click via `await import('./blend-proposal-pdf')` so those libs ship in a separate
// chunk instead of the main bundle.
import { composeBlendPdfFilename } from './blend-proposal-filename';
import type { BlendProposal, BlendProposalBlock } from '../blocking/actions';

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

export function buildBlendPrintDocument(proposal: BlendProposal, showPricesPref = true): string {
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

  // ── Selected blocks table (block, batch, balance, 7 lab columns, PHP/KG) ──
  const blockBody = proposal.blocks
    .map((b) => {
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
        `<td class="num">${formatKg(b.balance)}</td>` +
        labCells +
        priceCell +
        `</tr>`
      );
    })
    .join('');

  const labHeaders = LAB_ORDER.map(({ label }) => `<th class="num">${label}</th>`).join('');
  // tfoot spans: Block + Batch (2) under "Total", then Balance, then 7 empty lab cells.
  const blockTable = proposal.blocks.length
    ? `<table>` +
      `<thead><tr>` +
      `<th>Block</th><th>Batch</th><th class="num">Balance (kg)</th>` +
      labHeaders +
      (showPrices ? `<th class="num">PHP/KG</th>` : '') +
      `</tr></thead>` +
      `<tbody>${blockBody}</tbody>` +
      `<tfoot><tr>` +
      `<td colspan="2">Total</td>` +
      `<td class="num">${formatKg(proposal.total_balance)}</td>` +
      `<td colspan="${LAB_ORDER.length}"></td>` +
      (showPrices ? `<td></td>` : '') +
      `</tr></tfoot>` +
      `</table>`
    : `<p class="empty">No blocks selected.</p>`;

  const title = 'Blend Proposal';
  const subtitle = `${proposal.block_count} block${proposal.block_count === 1 ? '' : 's'} &middot; ${formatKg(
    proposal.total_balance,
  )} kg combined balance`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
  <h1>${title}</h1>
  <p class="subtitle">${subtitle}</p>

  <section>
    <h2>Summary</h2>
    <dl>${summaryRows.join('')}</dl>
  </section>

  <section>
    <h2>Blended Lab Stats (Weighted Avg)</h2>
    <dl>${labRows}</dl>
  </section>
${pricingSection}
  <section>
    <h2>Selected Blocks</h2>
    ${blockTable}
  </section>

  <div class="doc-footer">Blackwood ${EMDASH} Blend proposal &middot; Printed ${escapeHtml(
    new Date().toLocaleString(),
  )}</div>
</body>
</html>`;
}

// ─── Per-block table row ──────────────────────────────────────────────────────

function BlockRow({
  block,
  showPrices,
  onRemove,
  removeDisabled,
}: {
  block: BlendProposalBlock;
  showPrices: boolean;
  onRemove: (() => void) | undefined;
  removeDisabled: boolean;
}) {
  return (
    <tr className="border-b border-border/50 last:border-0">
      <td className="text-[10px] font-mono font-semibold text-foreground px-1.5 py-1 whitespace-nowrap">
        {block.block_loc}
      </td>
      <td className="text-[10px] text-muted-foreground px-1.5 py-1 max-w-[160px] truncate">
        {block.batch_code}
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

// ─── Component ────────────────────────────────────────────────────────────────

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
   * per-row remove control (read-only proposal).
   */
  onRemoveBlock?: (blockLoc: string) => void;
  /**
   * Client-side display preference from the Blocking "Prices" toggle — a HIDE-ONLY layer
   * on top of the server gate. Effective price visibility is `proposal.can_view_prices &&
   * showPrices`, so this can hide prices but never reveal them. Defaults to `true` (shown)
   * for callers that don't pass it.
   */
  showPrices?: boolean;
}

/**
 * Centered modal (Dialog) result panel for the Blocking "Blend Proposal" mode. Shows the
 * selected blocks (with per-block balance, full lab results, and price), the
 * balance-weighted lab blend, the combined balance + block count, and (price-gated) the
 * raw blended ₱/kg plus the yield-adjusted product cost with the formula spelled out.
 * Blocks can be removed in-place via the per-row X (the grid re-runs the blend). Includes
 * a Print button that generates a clean native document via the shared hidden-iframe
 * plumbing.
 *
 * Price gating: prices render ONLY when the EFFECTIVE flag is true — i.e.
 * `proposal.can_view_prices` (server gate, NEVER weakened) AND the `showPrices` display
 * preference AND the relevant value is non-null. The backend nulls all ₱ fields
 * server-side for Production users, so this component does NO role lookup — it relies
 * solely on the `can_view_prices` flag (ANDed with the display preference) + null checks.
 * The same effective flag gates the printed document AND the downloaded PDF. The per-block
 * lab columns are NOT gated.
 */
export function BlendProposalDialog({
  open,
  onOpenChange,
  proposal,
  loading,
  onRemoveBlock,
  showPrices: showPricesPref = true,
}: BlendProposalDialogProps) {
  // EFFECTIVE visibility = server gate AND the client display preference. Hide-only:
  // `showPricesPref` can flip this off but can never turn the server gate back on.
  const showPrices = !!proposal?.can_view_prices && showPricesPref;

  // ── Download PDF (label prompt) ──
  const [pdfPopoverOpen, setPdfPopoverOpen] = useState(false);
  const [pdfLabel, setPdfLabel] = useState('');
  // Live filename preview / validity — empty after sanitize means "require a label".
  const previewFilename = composeBlendPdfFilename(pdfLabel);
  const labelValid = previewFilename !== null;

  async function handleDownloadPdf() {
    if (!proposal || !labelValid) return;
    try {
      // Lazy-load jsPDF only when the user actually downloads (PERF-4).
      const { downloadBlendPdf } = await import('./blend-proposal-pdf');
      // Pass the display preference so a hidden-prices PDF carries NO ₱ (the PDF builder
      // re-ANDs it with the server `can_view_prices`).
      downloadBlendPdf(proposal, pdfLabel, showPricesPref);
      setPdfPopoverOpen(false);
      setPdfLabel('');
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
      const html = buildBlendPrintDocument(proposal, showPricesPref);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="animate-modal-enter w-[calc(100%-2rem)] max-w-4xl sm:max-w-4xl max-h-[85dvh] p-0 gap-0 overflow-hidden flex flex-col"
      >
        {/* ── Header (Print + close live here; stays fixed while body scrolls) ── */}
        <DialogHeader className="shrink-0 bg-background/90 backdrop-blur-sm border-b border-border px-4 py-3 text-left">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-md bg-primary/10 text-primary">
                <Calculator className="w-3.5 h-3.5" />
              </span>
              <div>
                <DialogTitle className="text-sm">Blend Proposal</DialogTitle>
                <DialogDescription className="text-xs">
                  Weighted blend across{' '}
                  {proposal
                    ? `${proposal.block_count} block${proposal.block_count === 1 ? '' : 's'}`
                    : 'selected blocks'}
                </DialogDescription>
              </div>
            </div>
            {/* Header actions */}
            <div className="flex items-center gap-1.5">
              {/* In-flight indicator while a remove re-runs the blend */}
              {loading && proposal && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" aria-label="Updating blend" />
              )}
              {/* Download PDF — prompts for a label via a Popover, then saves YYMMDD - {label}.pdf */}
              <Popover open={pdfPopoverOpen} onOpenChange={(o) => { setPdfPopoverOpen(o); if (!o) setPdfLabel(''); }}>
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
                        onClick={() => { setPdfPopoverOpen(false); setPdfLabel(''); }}
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
                className="flex items-center justify-center w-7 h-7 rounded-md border border-border
                           text-muted-foreground hover:text-foreground hover:bg-muted
                           transition-all duration-150 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
                title="Print blend proposal"
                aria-label="Print blend proposal"
              >
                <Printer className="w-3.5 h-3.5" />
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
        </DialogHeader>

        {/* ── Body (scrolls internally) ── */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
          {!proposal ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* ── Totals ── */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">Total Balance</div>
                  <div className="text-sm font-bold font-mono text-foreground">
                    {formatKg(proposal.total_balance)}{' '}
                    <span className="text-xs font-normal text-muted-foreground">kg</span>
                  </div>
                </div>
                <div className="rounded-md border border-border px-2.5 py-1.5">
                  <div className="text-[10px] font-medium text-muted-foreground uppercase">Blocks</div>
                  <div className="text-sm font-bold font-mono text-foreground">{proposal.block_count}</div>
                </div>
              </div>

              {/* ── Weighted lab blend ── */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Blended Lab Stats (Weighted Avg)
                </div>
                <div className="flex gap-1">
                  {LAB_ORDER.map(({ key, label }) => (
                    <div key={key} className="flex-1 min-w-0 rounded-md border border-border px-1 py-1 text-center">
                      <div className="text-[8px] font-medium text-muted-foreground uppercase">{label}</div>
                      <div className="text-xs font-mono font-bold text-foreground truncate">
                        {formatLab(key, proposal.weighted[key])}
                      </div>
                    </div>
                  ))}
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
                  <table className="w-full min-w-[640px] border-collapse">
                    <thead>
                      <tr>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Block
                        </th>
                        <th className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider text-left px-1.5 py-1 border-b border-border whitespace-nowrap">
                          Batch
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
                        {onRemoveBlock && <th className="w-[28px] border-b border-border" />}
                      </tr>
                    </thead>
                    <tbody>
                      {proposal.blocks.map((b) => (
                        <BlockRow
                          key={b.block_loc}
                          block={b}
                          showPrices={showPrices}
                          onRemove={onRemoveBlock ? () => onRemoveBlock(b.block_loc) : undefined}
                          removeDisabled={loading}
                        />
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-muted/50">
                        <td
                          className="text-[9px] font-semibold text-muted-foreground uppercase px-1.5 py-1 whitespace-nowrap"
                          colSpan={2}
                        >
                          Total
                        </td>
                        <td className="text-[10px] font-mono font-semibold text-foreground text-right px-1.5 py-1 whitespace-nowrap">
                          {formatKg(proposal.total_balance)} kg
                        </td>
                        {/* Empty cells under the lab columns */}
                        <td colSpan={labCols} />
                        {showPrices && <td />}
                        {onRemoveBlock && <td />}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
