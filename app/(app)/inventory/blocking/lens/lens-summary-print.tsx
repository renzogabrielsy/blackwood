'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE LENS SUMMARY, ON PAPER — one A4 landscape sheet of the ACTIVE lens as the
// reader has it configured.
//
// The owner: *"In the lens section, would be nice to also print some kind of summary
// based on the filter we set."* So this is not a report about the yard in general — it
// is a printout of THIS lens, with THESE cut lines, in THIS unit, and with the bands
// the reader has isolated. A sheet that quietly printed all four bands while the screen
// showed two would be describing a different filter from the one that produced it.
//
// ── IT IS THE PLATFORM PRINT KIT, NOT A NEW MECHANISM ───────────────────────
// `GroupPrintStage` (an offstage, really-laid-out 1040px column) + `printCard` (which
// marks the card, flattens every ancestor and calls `window.print()`) + the injected
// `@page` block from `print-page-rules.ts`. RC Movement's printed matrix and
// `/analytics`' metric cards are the same three pieces. **The stage is PORTALLED to
// `<body>`** — `printCard` flattens ancestors with `transform: none`, and Tailwind v4
// centres an overlay with the INDIVIDUAL `translate` property, which that does not
// reset; the legend bar is not an overlay today, but the portal is what keeps this
// sheet correct if it is ever triggered from inside one.
//
// ── THE SHEET IS EXPLICITLY LIGHT ───────────────────────────────────────────
// It is laid out in the LIVE DOM, so a theme token would print whatever theme the
// reader is in. Every surface here is an explicit `bg-white` / `text-zinc-*` /
// `border-zinc-*`, exactly as RC Movement's print sheet is. The two exceptions are
// deliberate: the band swatches and the ratio-bar segments use `lens-band-swatch` +
// `rampClass`, whose fill is a solid `rgb(var(--lens-hue))` and is identical in both
// themes — and identical to the colour on the grid, which is the whole point.
//
// ── IT COMPUTES NOTHING ─────────────────────────────────────────────────────
// Every kilogram, count, share and weighted figure arrives PREFORMATTED in the model
// the lens hands over. There is no sum, no share and no average in this file — the
// ratio bar's widths ARE the published shares, as they are on screen.
//
// ── ZERO TENANT KNOWLEDGE IS *NOT* CLAIMED ──────────────────────────────────
// This file lives in the Blocking module, not in `components/shared/`, because it knows
// what a block and a band are. What it takes FROM the platform layer is the mechanism
// only. Nothing under `components/shared/print` is modified by this feature.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { createPortal } from 'react-dom';
import { Printer } from 'lucide-react';

import { GroupPrintPage, GroupPrintStage } from '@/components/shared/print/group-print';
import {
  buildPrintPageRules,
  usePrintPageRules,
} from '@/components/shared/print/print-page-rules';
import { cn } from '@/lib/utils';

import { rampClass, type LensRampId } from './lens-ramp';
import { LensRatioBar } from './lens-ratio-bar';
import type { LensUnit } from './lens-shared';

// ── The model a lens hands over ─────────────────────────────────────────────

export interface LensSummaryBlockRow {
  blockLoc: string;
  batchCode: string;
  /** `74,590 kg`, preformatted. */
  kg: string;
  /** `₱48.50` or `412.7 d`, preformatted. Never a bare number. */
  figure: string;
}

export interface LensSummaryBand {
  index: number;
  /** The lens's OWN label for the band — the same function the legend uses. */
  label: string;
  /** `12 blocks`, preformatted. */
  blocks: string;
  /** `757,293 kg`, preformatted. */
  kg: string;
  /** PERCENT 0–100 as PUBLISHED, in the active unit. Null = nothing to share out. */
  sharePct: number | null;
  /** `28.99%` — the same number, preformatted, for the table cell. */
  share: string;
  /** The band's own weighted figure, preformatted. */
  figure: string;
  /** The blocks in it, already ordered (dearest / oldest first). */
  rows: LensSummaryBlockRow[];
}

export interface LensSummaryPrintModel {
  /** `Yard by price against market` / `Yard by age`. */
  title: string;
  /** The settings IN WORDS: basis, market and its rounding, or the as-of date. */
  settingsLines: string[];
  /** `Cut lines: −₱1, market` / `Cut lines: 60, 120, 365 days`. */
  cutLine: string;
  unit: LensUnit;
  ramp: LensRampId;
  /** EVERY band, in the payload's own order. Isolation is applied by the caller. */
  bands: LensSummaryBand[];
  /** How many bands the yard actually has, for the "Showing 2 of 4" line. */
  bandCount: number;
  /** The column heading for the weighted figure — `₱/kg` or `Age (d)`. */
  figureColumnLabel: string;
  total: {
    blocks: string;
    kg: string;
    figure: string;
    /**
     * WHAT the total's figure is an average OF.
     *
     * The price lens's `total.kgWeightedPhpKg` is weighted over the PRICED blocks while
     * its `blockCount` / `kg` count EVERY occupied block — a documented asymmetry, not
     * an accident (an unpriced block's ₱0 is the L-008 placeholder and averaging it in
     * is the ₱11.01-vs-₱39.99 `avg_cost` bug). The footer cell therefore says which
     * population its number covers, rather than leaving a reader to assume.
     */
    figureNote: string;
  };
  /** The population in NO band: unpriced for Price, undated for Age. */
  excluded: { title: string; note: string; rows: LensSummaryBlockRow[] } | null;
}

// ── The print rules ─────────────────────────────────────────────────────────

const LENS_PRINT_MARGIN_MM = 10;

/**
 * The `@page` block plus this sheet's own scoped rules.
 *
 * EXPORTED so the sheet can be mounted statically and measured, the same reason RC
 * Movement exports its own. **No `tfoot` rule** — Chrome repeats a `<tfoot>` on every
 * printed page, so the band table's total is the LAST `<tbody>` row.
 */
export const LENS_SUMMARY_PRINT_RULES = buildPrintPageRules({
  scopeAttr: 'data-lens-print',
  marginMm: LENS_PRINT_MARGIN_MM,
  extraCss: `
[data-lens-print] .lens-print-cols { column-count: 3; column-gap: 14px; }
[data-lens-print] .lens-print-cols > * { break-inside: avoid; }
[data-lens-print] .lens-print-band { break-inside: avoid; }
`,
});

// ── The sheet ───────────────────────────────────────────────────────────────

const TH = 'border border-zinc-400 bg-zinc-100 px-1 py-[2px] text-[8px] font-bold uppercase text-zinc-800';
const TD = 'border border-zinc-300 px-1 py-[2px] text-[9px] text-zinc-900';

function LensSummarySheet({
  model,
  printedAt,
}: {
  model: LensSummaryPrintModel;
  printedAt: string;
}) {
  const shown = model.bands.length;
  return (
    <div data-lens-print className="bg-white text-zinc-900">
      <h1 className="text-[15px] font-bold leading-tight">{model.title}</h1>
      <p className="mt-[1px] text-[9px] text-zinc-600">
        {model.settingsLines.join(' · ')}
      </p>
      <p className="text-[9px] text-zinc-600">
        {model.cutLine} · measured by {model.unit === 'kg' ? 'kilograms' : 'block count'} · printed{' '}
        {printedAt}
      </p>
      {shown < model.bandCount && (
        <p className="mt-[2px] text-[9px] font-semibold text-zinc-900">
          Showing {shown} of {model.bandCount} bands — the bands isolated on screen.
        </p>
      )}

      {/* ── The band table. Its TOTAL is the last tbody row, never a tfoot. ── */}
      <table className="mt-2 w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: '38%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '20%' }} />
        </colgroup>
        <thead>
          <tr>
            <th className={cn(TH, 'text-left')}>Band</th>
            <th className={cn(TH, 'text-right')}>Blocks</th>
            <th className={cn(TH, 'text-right')}>Kg</th>
            <th className={cn(TH, 'text-right')}>Share</th>
            <th className={cn(TH, 'text-right')}>{model.figureColumnLabel}</th>
          </tr>
        </thead>
        <tbody>
          {model.bands.map((b) => (
            <tr key={b.index}>
              <td className={TD}>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-sm border border-zinc-400',
                      rampClass(model.ramp, b.index, model.bandCount),
                      'lens-band-swatch',
                    )}
                  />
                  {b.label}
                </span>
              </td>
              <td className={cn(TD, 'text-right font-mono')}>{b.blocks}</td>
              <td className={cn(TD, 'text-right font-mono')}>{b.kg}</td>
              <td className={cn(TD, 'text-right font-mono')}>{b.share}</td>
              <td className={cn(TD, 'text-right font-mono')}>{b.figure}</td>
            </tr>
          ))}
          <tr>
            <td className={cn(TD, 'bg-zinc-100 font-bold')}>Whole yard</td>
            <td className={cn(TD, 'bg-zinc-100 text-right font-mono font-bold')}>
              {model.total.blocks}
            </td>
            <td className={cn(TD, 'bg-zinc-100 text-right font-mono font-bold')}>{model.total.kg}</td>
            <td className={cn(TD, 'bg-zinc-100 text-right font-mono font-bold')}>100.0%</td>
            <td className={cn(TD, 'bg-zinc-100 text-right font-mono font-bold')}>
              {model.total.figure}
              <span className="ml-1 font-sans text-[7px] font-normal text-zinc-600">
                {model.total.figureNote}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {/* The ratio bar — widths ARE the published shares. */}
      <div className="mt-2">
        <LensRatioBar
          ramp={model.ramp}
          segments={model.bands.map((b) => ({ key: b.index, sharePct: b.sharePct }))}
          ariaLabel={model.bands.map((b) => `${b.label}: ${b.share}`).join('; ')}
          trackClassName="border-zinc-400 bg-zinc-100"
        />
      </div>

      {/* ── The blocks of each band, in compact multi-column lists ── */}
      {model.bands.map((b) => (
        <div key={b.index} className="lens-print-band mt-2">
          <p className="flex items-baseline gap-1.5 border-b border-zinc-400 pb-[1px] text-[9px] font-bold uppercase text-zinc-900">
            <span
              aria-hidden
              className={cn(
                'h-2 w-2 shrink-0 self-center rounded-sm border border-zinc-400',
                rampClass(model.ramp, b.index, model.bandCount),
                'lens-band-swatch',
              )}
            />
            {b.label}
            <span className="font-mono font-normal text-zinc-600">
              {b.blocks} · {b.kg} · {b.share} · {b.figure}
            </span>
          </p>
          {b.rows.length === 0 ? (
            <p className="text-[9px] italic text-zinc-500">No block is in this band.</p>
          ) : (
            <ul className="lens-print-cols mt-[2px]">
              {b.rows.map((r) => (
                <li
                  key={r.blockLoc}
                  className="flex items-baseline justify-between gap-1 text-[8.5px] leading-[11px] text-zinc-900"
                >
                  <span className="truncate">
                    <span className="font-mono font-semibold">{r.blockLoc}</span>{' '}
                    <span className="text-zinc-600">{r.batchCode}</span>
                  </span>
                  <span className="shrink-0 font-mono">
                    {r.kg} · {r.figure}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}

      {/* The population in NO band — muted, listed, never folded into a band. */}
      {model.excluded && model.excluded.rows.length > 0 && (
        <div className="lens-print-band mt-2">
          <p className="border-b border-dashed border-zinc-400 pb-[1px] text-[9px] font-bold uppercase text-zinc-600">
            {model.excluded.title}
          </p>
          <p className="text-[8px] text-zinc-500">{model.excluded.note}</p>
          <ul className="lens-print-cols mt-[2px]">
            {model.excluded.rows.map((r) => (
              <li
                key={r.blockLoc}
                className="flex items-baseline justify-between gap-1 text-[8.5px] leading-[11px] text-zinc-600"
              >
                <span className="truncate">
                  <span className="font-mono font-semibold">{r.blockLoc}</span> {r.batchCode}
                </span>
                <span className="shrink-0 font-mono">{r.kg}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── The control ─────────────────────────────────────────────────────────────

/** `yyyy-MM-dd HH:mm` — the project's date format, plus the clock. */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`;
}

export interface LensSummaryPrintControlProps {
  /** Built by the lens. Null while its payload has not arrived — the button is then off. */
  model: LensSummaryPrintModel | null;
  /** What the button's tooltip calls this lens. */
  lensLabel: string;
}

export function LensSummaryPrintControl({ model, lensLabel }: LensSummaryPrintControlProps) {
  // Non-null MOUNTS the offstage stage, which calls `printCard` on itself once it has
  // laid out and unmounts on `afterprint`. The timestamp is captured HERE, on the
  // click, so it is client-only and can never be a hydration mismatch.
  const [printedAt, setPrintedAt] = React.useState<string | null>(null);
  usePrintPageRules(printedAt ? LENS_SUMMARY_PRINT_RULES : null, 'bw-lens-print-rules');

  const disabled = model === null;

  return (
    <>
      <button
        type="button"
        data-lens-print-button
        disabled={disabled}
        onClick={() => setPrintedAt(stamp(new Date()))}
        title={
          disabled
            ? 'Nothing to print yet — the lens is still working out its bands.'
            : `Print a one-sheet summary of the ${lensLabel} lens as it is set up now`
        }
        aria-label={`Print the ${lensLabel} lens summary`}
        className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-sm border border-border bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground transition-colors duration-150 hover:text-foreground cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
      >
        <Printer className="h-2.5 w-2.5" />
        <span className="max-sm:hidden">Print</span>
      </button>

      {printedAt && model
        ? createPortal(
            <GroupPrintStage
              // NO STAGE HEADER — the sheet carries its own title, the settings and the
              // printed-at line, and a second heading restating them is wordiness.
              showHeader={false}
              title={model.title}
              subtitle={model.settingsLines.join(' · ')}
              countLabel="1 page"
              onDone={() => setPrintedAt(null)}
            >
              <GroupPrintPage>
                <LensSummarySheet model={model} printedAt={printedAt} />
              </GroupPrintPage>
            </GroupPrintStage>,
            document.body,
          )
        : null}
    </>
  );
}
