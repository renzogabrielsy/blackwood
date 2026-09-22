'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PAGE ONE'S PRICE vs VOLUME — what each supplier in the yard has been CHARGING, and how
// much they have been SENDING.
//
// The owner, on the barren lower half of the supplier lens's first page: *"utilize the
// existing price-to-volume graph / area graph; a table that shows the direction of price
// per supplier and its relationship with the volume delivered."*
//
// Two halves, both `fetchBlockingSupplierMarket(12, bandKeys)` rendered verbatim:
//   SMALL MULTIPLES  one panel per named band supplier — kilograms as an AREA, ₱/kg as a
//                    LINE over the same twelve months. The shape `/analytics`'
//                    `supplier-expand.tsx` draws on screen, re-drawn for paper (see
//                    `lens-print-chart.tsx` for why it is SVG rather than recharts).
//   THE TABLE        one row per band supplier: kilograms, weighted ₱/kg, first → last,
//                    change %, DIRECTION, volume change %, CORRELATION and premium vs
//                    market, with a footer from `selectedTotal` beside `windowTotal`.
//
// ── ⚠️ EACH PANEL SCALES TO ITS OWN RANGE, AND THE CAPTION SAYS SO ──────────
// The live yard's suppliers differ by two orders of magnitude (ORNALES 5,620,744 kg
// against LAYUPAN's share of 2.84%), so a shared volume axis would flatten every small
// supplier to the baseline and answer nothing about its direction — which is the question
// asked. Per-panel autoscale with the axis numbers PRINTED is the honest trade, and the
// caption states it rather than leaving a reader to compare two differently-scaled panels
// by eye.
//
// ── `OTHERS` IS NOT A SUPPLIER, SO IT HAS NO PANEL AND NO ROW ───────────────
// The `others` band is a FOLD of every supplier outside the top N; the market payload is
// keyed on real canonical suppliers and publishes no series for a fold. Aggregating one
// here would be a TypeScript average of weighted prices, which is exactly what CLAUDE.md
// forbids and what `view_analytics_supplier_monthly` exists to own. So `others` is simply
// absent, and the band table above on the same page still carries its figures.
//
// ── THE WHOLE SECTION IS ABSENT FOR A PRICE-DENIED READER ───────────────────
// It is money almost end to end — including `priceVolumeCorr`, which is DERIVED from
// price and is price information however it is labelled — so
// `fetchBlockingSupplierMarket` REFUSES rather than nulling, and the panel does not even
// ask when the effective flag is false. The supplier lens itself still prints in full:
// its band table (with the `Mixed` column), its yard map and its per-band pages are
// unconditional, because the rest of that payload is peso-free and Production is the role
// that walks the yard.
//
// ── IT FORMATS NOTHING ──────────────────────────────────────────────────────
// Every string is `lens-supplier-market-model`'s; no `toFixed`, no `toLocaleString`, no ₱
// glyph in this file.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import { cn } from '@/lib/utils';

import { PrintChartLegend, PrintSeriesChart } from './lens-print-chart';
import type { LensSupplierMarketPrintModel } from './lens-market-model';

const TH =
  'border border-zinc-400 bg-zinc-100 px-1 py-[1px] text-[7px] font-bold uppercase text-zinc-800';
const TD = 'border border-zinc-300 px-1 py-[1px] text-[7.5px] text-zinc-900';

/**
 * ONE panel's box, in PIXELS — fixed, for the reason `lens-print-chart.tsx` records.
 *
 * Three across: A4 landscape at a 10 mm margin is 1047 px of printable width, so
 * 3 × 335 + two 6 px gaps = 1017 px fits with room for the page's own padding.
 */
const PANEL_W_PX = 335;
const PANEL_H_PX = 112;
/** How many panels a row holds. The table below still lists every supplier. */
export const LENS_SUPPLIER_MARKET_PANEL_COLS = 3;

export function LensSupplierMarketSection({
  model,
}: {
  model: LensSupplierMarketPrintModel;
}) {
  return (
    <section className="mt-2">
      <h2 className="flex items-baseline gap-1.5 border-b border-zinc-400 pb-[1px] text-[10px] font-bold uppercase text-zinc-900">
        Price vs volume
        <span className="font-mono text-[8px] font-normal normal-case text-zinc-600">
          {model.caption}
        </span>
      </h2>

      {/* ── SMALL MULTIPLES ─────────────────────────────────────────────────── */}
      {model.panels.length > 0 && (
        <>
          <div
            className="mt-[3px] grid"
            style={{
              gridTemplateColumns: `repeat(${LENS_SUPPLIER_MARKET_PANEL_COLS}, ${PANEL_W_PX}px)`,
              gap: '4px 6px',
            }}
          >
            {model.panels.map((p) => (
              <div key={p.key}>
                <p className="flex items-baseline gap-1 text-[8px] font-bold uppercase leading-tight text-zinc-900">
                  {p.title}
                  <span className="font-mono text-[7px] font-normal normal-case text-zinc-600">
                    {p.subtitle}
                  </span>
                </p>
                <PrintSeriesChart
                  widthPx={PANEL_W_PX}
                  heightPx={PANEL_H_PX}
                  points={p.points}
                  lineDomain={p.lineDomain}
                  areaDomain={p.areaDomain}
                  lineTicks={p.lineTicks}
                  areaTicks={p.areaTicks}
                  ariaLabel={p.ariaLabel}
                />
              </div>
            ))}
          </div>
          {/* Each ink says what IT means; the caption underneath says how to READ two
              panels that are scaled differently. Both strings are the model's. */}
          <PrintChartLegend
            entries={[
              { kind: 'area', label: model.areaLegend },
              { kind: 'line', label: model.lineLegend },
            ]}
          />
          <p className="text-[7px] text-zinc-600">{model.chartCaption}</p>
        </>
      )}

      {/* ── THE TABLE ───────────────────────────────────────────────────────── */}
      <table className="mt-[3px] w-full table-fixed border-collapse">
        <colgroup>
          <col style={{ width: '17%' }} />
          <col style={{ width: '13%' }} />
          <col style={{ width: '11%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '9%' }} />
          <col style={{ width: '9%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '8%' }} />
        </colgroup>
        <thead>
          <tr>
            <th className={cn(TH, 'text-left')}>Supplier</th>
            <th className={cn(TH, 'text-right')}>Kg</th>
            <th className={cn(TH, 'text-right')}>PHP/kg wtd</th>
            <th className={cn(TH, 'text-right')}>First &rarr; last</th>
            <th className={cn(TH, 'text-right')}>Change</th>
            <th className={cn(TH, 'text-left')}>Dir</th>
            <th className={cn(TH, 'text-right')}>Vol %</th>
            <th className={cn(TH, 'text-right')}>Corr</th>
            <th className={cn(TH, 'text-right')}>Prem</th>
          </tr>
        </thead>
        <tbody>
          {model.rows.map((r) => (
            <tr key={r.key}>
              <td className={cn(TD, 'truncate font-semibold')}>{r.supplier}</td>
              <td className={cn(TD, 'text-right font-mono')}>{r.kg}</td>
              <td className={cn(TD, 'text-right font-mono')}>{r.phpKg}</td>
              <td className={cn(TD, 'text-right font-mono')}>{r.firstLast}</td>
              <td className={cn(TD, 'text-right font-mono')}>{r.changePct}</td>
              <td className={cn(TD, 'font-mono')}>{r.direction}</td>
              <td className={cn(TD, 'text-right font-mono')}>{r.volumeChangePct}</td>
              <td className={cn(TD, 'text-right font-mono')}>{r.corr}</td>
              <td className={cn(TD, 'text-right font-mono')}>{r.premium}</td>
            </tr>
          ))}
          {/* THE FOOTER — the SELECTION's own total, with the WHOLE market beside it, so a
              row is comparable to the market rather than only to its neighbours. A body
              row, never a `<tfoot>`: Chrome repeats a tfoot on every printed sheet. */}
          <tr className="bg-zinc-100">
            <td className={cn(TD, 'font-bold uppercase')}>{model.footer.label}</td>
            <td className={cn(TD, 'text-right font-mono font-bold')}>{model.footer.kg}</td>
            <td className={cn(TD, 'text-right font-mono font-bold')}>{model.footer.phpKg}</td>
            <td className={cn(TD, 'font-sans text-[7px] text-zinc-600')} colSpan={6}>
              {model.footer.note}
            </td>
          </tr>
        </tbody>
      </table>

      {/* A named band the market payload has no series for is NAMED, never dropped. */}
      {model.omittedNote !== '' && (
        <p className="mt-[1px] text-[7px] text-zinc-600">{model.omittedNote}</p>
      )}
    </section>
  );
}
