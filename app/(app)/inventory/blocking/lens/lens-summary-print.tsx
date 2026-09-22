'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE LENS SUMMARY, ON PAPER — the ACTIVE lens as the reader has it configured.
//
// The owner: *"In the lens section, would be nice to also print some kind of summary
// based on the filter we set."* So this is not a report about the yard in general — it
// is a printout of THIS lens, with THESE cut lines, in THIS unit, and with the bands
// the reader has isolated. A sheet that quietly printed all four bands while the screen
// showed two would be describing a different filter from the one that produced it.
//
// ── THE 2026-09-22 REDESIGN — WHAT THE OWNER ASKED FOR, AND WHAT CHANGED ────
// *"It should just be called price lens. No AI-slop description/subheading. I like the
// ratio bar, keep that. I don't like the three-column groupings — subgroup what fits
// each band by WAREHOUSE location; spanning multiple pages is fine because you can fit
// more lab analysis data."* Four changes, in his order:
//
//   1. THE TITLE IS THE LENS'S NAME AND NOTHING ELSE — `Price lens` / `Age lens` /
//      `Supplier lens`. The old title was a sentence about the yard.
//   2. ONE TERSE SETTINGS LINE under it, in the same `<fact> · <fact>` style the
//      analysis captions moved to on the same day. No blurb, no explanation of what a
//      weighted average is; the figures are the content.
//   3. THE BAND TABLE AND THE RATIO BAR ARE KEPT, unchanged in shape. They were the
//      part he said worked.
//   4. THE THREE-COLUMN BLOCK LISTS ARE GONE. Each band is now a FULL-WIDTH table
//      grouped by WAREHOUSE, carrying every lab reading the grid already holds — and
//      each band starts on a NEW PAGE, because more pages is the trade he asked for.
//
// ── THE LAB READINGS ARE READ, NEVER COMPUTED ───────────────────────────────
// They come off the grid payload the page already holds (`view_blocking_grid` rows),
// joined by `block_loc`. A WAREHOUSE SUBTOTAL therefore carries its block count and its
// kilograms and leaves **every lab cell BLANK**: a kg-weighted MC over a partition SQL
// never computed would be a second definition of a lab average, living in TypeScript.
// A blank cell says "not published"; a computed one would say something untrue. The one
// sum that does happen — the warehouse kilograms — is stated and justified in
// `lens-summary-model.ts`, and the band and yard totals beside it stay the payload's.
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
// the ramp class, whose fill is a solid `rgb(var(--lens-hue))` and is identical in both
// themes — and identical to the colour on the grid, which is the whole point.
//
// ── ZERO TENANT KNOWLEDGE IS *NOT* CLAIMED ──────────────────────────────────
// This file lives in the Blocking module, not in `components/shared/`, because it knows
// what a block, a band and a warehouse are. What it takes FROM the platform layer is the
// mechanism only. Nothing under `components/shared/print` is modified by this feature.
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

import { rampClass, rampClassAtStop, type LensRampId } from './lens-ramp';
import { LensRatioBar } from './lens-ratio-bar';
import type { LensUnit } from './lens-shared';
import {
  LENS_SUMMARY_LAB_KEYS,
  LENS_SUMMARY_LAB_LABELS,
  type LensSummaryBlockRow,
  type LensSummaryWarehouse,
} from './lens-summary-model';

export type { LensSummaryBlockRow, LensSummaryWarehouse };

// ── The model a lens hands over ─────────────────────────────────────────────

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
  /**
   * The ramp stop this band wears, when the LENS decides it rather than its position.
   * Ordinal lenses (price, age) omit it; the NOMINAL supplier lens states it so the
   * `others` fold always takes the reserved neutral. See `lens-ramp.ts`.
   */
  rampStop?: number;
  /** Its blocks, grouped by warehouse in the page's own warehouse order. */
  warehouses: LensSummaryWarehouse[];
}

export interface LensSummaryPrintModel {
  /** EXACTLY the lens's name — `Price lens` / `Age lens` / `Supplier lens`. */
  title: string;
  /**
   * ONE terse settings line: `<fact> · <fact> · <fact>`.
   *
   * The sheet appends ` · printed <stamp>` itself, so a lens never has to know the
   * clock and the stamp can stay a click-time value that cannot be a hydration
   * mismatch.
   */
  settingsLine: string;
  unit: LensUnit;
  ramp: LensRampId;
  /** EVERY band, in the payload's own order. Isolation is applied by the caller. */
  bands: LensSummaryBand[];
  /** How many bands the yard actually has, for the "Showing 2 of 4" line. */
  bandCount: number;
  /** The column heading for the per-block figure — `₱/kg` / `Age (d)` / `Supplier`. */
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
     * population its number covers, rather than leaving a reader to assume. An empty
     * string prints nothing, for a lens whose total needs no qualifier.
     */
    figureNote: string;
  };
  /** The population in NO band: unpriced / undated / no supplier at all. */
  excluded: { title: string; note: string; rows: LensSummaryBlockRow[] } | null;
}

// ── The print rules ─────────────────────────────────────────────────────────

const LENS_PRINT_MARGIN_MM = 10;

/**
 * The `@page` block plus this sheet's own scoped rules.
 *
 * EXPORTED so the sheet can be mounted statically and measured, the same reason RC
 * Movement exports its own. **No `tfoot` rule** — Chrome repeats a `<tfoot>` on every
 * printed page, so every total here is the LAST `<tbody>` row.
 *
 * `break-before: page` on `.lens-print-band` is what makes each band start a fresh
 * sheet: page one is the title, the settings line, the band table and the ratio bar,
 * and then one page per band. A warehouse group is one `<tbody>`, `break-inside: avoid`
 * while it is small enough to travel whole, and its heading row carries
 * `break-after: avoid` so a large group's title cannot be stranded at a page foot.
 */
export const LENS_SUMMARY_PRINT_RULES = buildPrintPageRules({
  scopeAttr: 'data-lens-print',
  marginMm: LENS_PRINT_MARGIN_MM,
  extraCss: `
[data-lens-print] .lens-print-band { break-before: page; page-break-before: always; }
[data-lens-print] .lens-print-band h2 { break-after: avoid; }
[data-lens-print] tbody.lens-print-whse-small { break-inside: avoid; }
[data-lens-print] tr.lens-print-whse-head { break-after: avoid; }
`,
});

/** How many rows still let a warehouse group travel whole on one sheet. */
const SMALL_WAREHOUSE_ROWS = 6;

// ── The sheet ───────────────────────────────────────────────────────────────

const TH = 'border border-zinc-400 bg-zinc-100 px-1 py-[2px] text-[8px] font-bold uppercase text-zinc-800';
const TD = 'border border-zinc-300 px-1 py-[2px] text-[9px] text-zinc-900';
/** The 7pt floor the whole print kit keeps. Nothing below this is emitted. */
const TD_SMALL = 'border border-zinc-300 px-1 py-[2px] text-[7.5px] text-zinc-900';

/** BLOCK · BATCH · BALANCE, then the seven lab columns, then the lens's own figure. */
const BLOCK_COL_WIDTHS = ['8%', '17%', '11%'] as const;
const LAB_COL_WIDTH = '7.5%';
const FIGURE_COL_WIDTH = '11.5%';

function bandSwatchClass(model: LensSummaryPrintModel, band: LensSummaryBand): string {
  return band.rampStop === undefined
    ? rampClass(model.ramp, band.index, model.bandCount)
    : rampClassAtStop(model.ramp, band.rampStop);
}

/** One band's blocks: a full-width table, one `<tbody>` per warehouse. */
function BandBlocksTable({
  band,
  figureColumnLabel,
}: {
  band: LensSummaryBand;
  figureColumnLabel: string;
}) {
  const colCount = 3 + LENS_SUMMARY_LAB_KEYS.length + 1;

  if (band.warehouses.length === 0) {
    return <p className="text-[9px] italic text-zinc-500">No block is in this band.</p>;
  }

  return (
    <table className="mt-[3px] w-full table-fixed border-collapse">
      <colgroup>
        {BLOCK_COL_WIDTHS.map((w) => (
          <col key={w} style={{ width: w }} />
        ))}
        {LENS_SUMMARY_LAB_KEYS.map((k) => (
          <col key={k} style={{ width: LAB_COL_WIDTH }} />
        ))}
        <col style={{ width: FIGURE_COL_WIDTH }} />
      </colgroup>
      <thead>
        <tr>
          <th className={cn(TH, 'text-left')}>Block</th>
          <th className={cn(TH, 'text-left')}>Batch</th>
          <th className={cn(TH, 'text-right')}>Balance kg</th>
          {LENS_SUMMARY_LAB_KEYS.map((k) => (
            <th key={k} className={cn(TH, 'text-right')}>
              {LENS_SUMMARY_LAB_LABELS[k]}
            </th>
          ))}
          <th className={cn(TH, 'text-right')}>{figureColumnLabel}</th>
        </tr>
      </thead>
      {band.warehouses.map((w) => (
        <tbody
          key={w.key}
          className={w.rows.length <= SMALL_WAREHOUSE_ROWS ? 'lens-print-whse-small' : undefined}
        >
          <tr className="lens-print-whse-head bg-zinc-100">
            <td className={cn(TD, 'font-bold uppercase')} colSpan={colCount}>
              {w.label}
              <span className="ml-1.5 font-mono font-normal text-zinc-600">
                {w.blocks} · {w.kg}
              </span>
            </td>
          </tr>
          {w.rows.map((r) => (
            <tr key={r.blockLoc}>
              <td className={cn(TD_SMALL, 'font-mono font-semibold')}>{r.blockLoc}</td>
              <td className={cn(TD_SMALL, 'truncate')}>{r.batchCode}</td>
              <td className={cn(TD_SMALL, 'text-right font-mono')}>{r.kg}</td>
              {LENS_SUMMARY_LAB_KEYS.map((k) => (
                <td key={k} className={cn(TD_SMALL, 'text-right font-mono')}>
                  {r.lab[k]}
                </td>
              ))}
              <td className={cn(TD_SMALL, 'text-right font-mono')}>{r.figure}</td>
            </tr>
          ))}
          {/* THE WAREHOUSE SUBTOTAL — blocks and kilograms only. Every lab cell is
              deliberately BLANK: a kg-weighted reading over a partition the payload
              does not publish would be a second definition of a lab average. */}
          <tr className="bg-zinc-50">
            <td className={cn(TD_SMALL, 'font-bold uppercase')} colSpan={2}>
              {w.label} subtotal
            </td>
            <td className={cn(TD_SMALL, 'text-right font-mono font-bold')}>{w.kg}</td>
            {LENS_SUMMARY_LAB_KEYS.map((k) => (
              <td key={k} className={TD_SMALL} />
            ))}
            <td className={TD_SMALL} />
          </tr>
        </tbody>
      ))}
      {/* THE BAND TOTAL — the payload's own figures, never a fold of the rows above. */}
      <tbody>
        <tr className="bg-zinc-200">
          <td className={cn(TD, 'font-bold uppercase')} colSpan={2}>
            Band total
          </td>
          <td className={cn(TD, 'text-right font-mono font-bold')}>{band.kg}</td>
          {LENS_SUMMARY_LAB_KEYS.map((k) => (
            <td key={k} className={TD} />
          ))}
          <td className={cn(TD, 'text-right font-mono font-bold')}>{band.figure}</td>
        </tr>
      </tbody>
    </table>
  );
}

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
      {/* THE TITLE IS THE LENS'S NAME. Nothing else, and no subheading under it. */}
      <h1 className="text-[15px] font-bold leading-tight">{model.title}</h1>
      <p className="mt-[1px] text-[9px] text-zinc-600">
        {model.settingsLine} · printed {printedAt}
      </p>
      {shown < model.bandCount && (
        <p className="mt-[2px] text-[9px] font-semibold text-zinc-900">
          Showing {shown} of {model.bandCount} bands
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
                      bandSwatchClass(model, b),
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
              {model.total.figureNote !== '' && (
                <span className="ml-1 font-sans text-[7px] font-normal text-zinc-600">
                  {model.total.figureNote}
                </span>
              )}
            </td>
          </tr>
        </tbody>
      </table>

      {/* The ratio bar — widths ARE the published shares. KEPT, per the owner. */}
      <div className="mt-2">
        <LensRatioBar
          ramp={model.ramp}
          segments={model.bands.map((b) => ({
            key: b.index,
            sharePct: b.sharePct,
            rampStop: b.rampStop,
          }))}
          ariaLabel={model.bands.map((b) => `${b.label}: ${b.share}`).join('; ')}
          trackClassName="border-zinc-400 bg-zinc-100"
        />
      </div>

      {/* ── One PAGE per band: its blocks, grouped by warehouse, with the lab panel ── */}
      {model.bands.map((b) => (
        <div key={b.index} className="lens-print-band">
          <h2 className="flex items-baseline gap-1.5 border-b border-zinc-400 pb-[1px] text-[11px] font-bold uppercase text-zinc-900">
            <span
              aria-hidden
              className={cn(
                'h-2.5 w-2.5 shrink-0 self-center rounded-sm border border-zinc-400',
                bandSwatchClass(model, b),
                'lens-band-swatch',
              )}
            />
            {b.label}
            <span className="font-mono text-[9px] font-normal text-zinc-600">
              {b.blocks} · {b.kg} · {b.share} · {b.figure}
            </span>
          </h2>
          <BandBlocksTable band={b} figureColumnLabel={model.figureColumnLabel} />
        </div>
      ))}

      {/* The population in NO band — its own page, muted, never folded into a band. */}
      {model.excluded && model.excluded.rows.length > 0 && (
        <div className="lens-print-band">
          <h2 className="border-b border-dashed border-zinc-400 pb-[1px] text-[11px] font-bold uppercase text-zinc-600">
            {model.excluded.title}
          </h2>
          <p className="text-[8px] text-zinc-500">{model.excluded.note}</p>
          <BandBlocksTable
            band={{
              index: -1,
              label: model.excluded.title,
              blocks: '',
              kg: '',
              sharePct: null,
              share: '',
              figure: '',
              warehouses: [
                {
                  key: '-',
                  label: 'In no band',
                  blocks: '',
                  kg: '',
                  rows: model.excluded.rows,
                },
              ],
            }}
            figureColumnLabel={model.figureColumnLabel}
          />
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
            : `Print a summary of the ${lensLabel} lens as it is set up now`
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
              // NO STAGE HEADER — the sheet carries its own title, its settings line and
              // the printed-at stamp, and a second heading restating them is wordiness.
              showHeader={false}
              title={model.title}
              subtitle={model.settingsLine}
              countLabel={`${model.bands.length + 1} page${model.bands.length === 0 ? '' : 's'}`}
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
