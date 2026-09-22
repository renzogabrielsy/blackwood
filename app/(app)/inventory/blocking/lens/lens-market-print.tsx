'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PAGE ONE'S MARKET CONTEXT — what the number the whole lens is cut against has been
// DOING.
//
// The owner, on the barren lower half of the price lens's first page: *"maybe a
// deliveries price for the year — an indication of what the market price is."* The lens
// says what the yard looks like TODAY against ONE price; it could not say whether that
// price is high or low, and a sheet that answered by averaging deliveries in TypeScript
// would be inventing a second definition of "market".
//
// So the whole block is `fetchBlockingMarketContext(12)` rendered verbatim:
//   the TABLE   one row per month that HAS a row, then each quarter those months span
//               (the current one flagged), then Year to date and Trailing 12 m
//   the CHART   the same twelve monthly ₱/kg, with the lens's OWN basis price drawn as a
//               dashed reference level — which is the comparison the owner asked for
//
// ── IT FORMATS NOTHING, FOR THE SAME REASON THE SHEET DOES NOT ──────────────
// Every string here is built by `lens-market-model.ts` and every number on the chart is a
// field of the payload. There is no `toFixed`, no `toLocaleString` and no ₱ glyph in this
// file: if a peso is ever written differently on this sheet it will be because ONE
// function changed.
//
// ── THE WHOLE SECTION IS ABSENT, NEVER BLANK ────────────────────────────────
// The payload is money end to end, so `fetchBlockingMarketContext` REFUSES a
// `!canViewPrices()` caller rather than nulling — and the price lens's Print button is
// already behind that same flag. A refusal, an error or a read that has not landed yet
// therefore leaves this section OUT of the model, and the sheet prints page one exactly as
// it did before. A section that appeared with empty cells would say the market has no
// price, which is a different and untrue statement.
//
// ── EXPLICITLY LIGHT ────────────────────────────────────────────────────────
// It lays out in the LIVE DOM like the rest of the sheet, so every surface is an explicit
// `zinc` / hex and the chart's ink is a constant. A theme token here would print dark for
// a dark-mode reader.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';

import { cn } from '@/lib/utils';

import { PrintChartLegend, PrintSeriesChart } from './lens-print-chart';
import type { LensMarketPrintModel } from './lens-market-model';

/** The same table chrome the band tables use, so page one reads as one sheet. */
const TH =
  'border border-zinc-400 bg-zinc-100 px-1 py-[1px] text-[7px] font-bold uppercase text-zinc-800';
const TD = 'border border-zinc-300 px-1 py-[1px] text-[7.5px] text-zinc-900';

/**
 * The chart's box, in PIXELS, stated here and nowhere else.
 *
 * Fixed rather than responsive, and that is the point: `printCard` calls
 * `window.print()` on the frame after the offstage stage lays out, so anything that sizes
 * itself from a ResizeObserver callback prints an empty box. See
 * `lens-print-chart.tsx`'s header for the full reasoning.
 */
const CHART_W_PX = 430;
const CHART_H_PX = 132;

export function LensMarketContextSection({ model }: { model: LensMarketPrintModel }) {
  return (
    <section className="mt-2">
      <h2 className="flex items-baseline gap-1.5 border-b border-zinc-400 pb-[1px] text-[10px] font-bold uppercase text-zinc-900">
        Market
        <span className="font-mono text-[8px] font-normal normal-case text-zinc-600">
          {model.caption}
        </span>
      </h2>

      {/* Table LEFT, chart RIGHT — measured: the table is up to 19 rows tall and the
          chart 132px, so stacking them would push the band pages' first sheet over one
          page on a seven-band lens. Side by side, page one holds. */}
      <div className="mt-[3px] flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col style={{ width: '30%' }} />
              <col style={{ width: '19%' }} />
              <col style={{ width: '23%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className={cn(TH, 'text-left')}>Month</th>
                <th className={cn(TH, 'text-right')}>PHP/kg</th>
                <th className={cn(TH, 'text-right')}>Kg</th>
                <th className={cn(TH, 'text-right')}>Dlv</th>
                <th className={cn(TH, 'text-right')}>Supp</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r) => (
                <tr
                  key={r.key}
                  className={cn(
                    r.rollup && 'bg-zinc-50',
                    // THE BASIS'S OWN ROW — the one this lens is cut against. A border
                    // rather than a fill, so it still reads as its own row and does not
                    // fight the rollup tint underneath it.
                    r.highlighted && 'bg-zinc-200',
                  )}
                >
                  <td
                    className={cn(
                      TD,
                      (r.rollup || r.highlighted) && 'font-bold uppercase',
                    )}
                  >
                    {r.label}
                    {r.note !== '' && (
                      <span className="ml-1 font-sans text-[7px] font-normal normal-case text-zinc-600">
                        {r.note}
                      </span>
                    )}
                  </td>
                  <td
                    className={cn(
                      TD,
                      'text-right font-mono',
                      (r.rollup || r.highlighted) && 'font-bold',
                    )}
                  >
                    {r.price}
                  </td>
                  <td className={cn(TD, 'text-right font-mono')}>{r.kg}</td>
                  <td className={cn(TD, 'text-right font-mono')}>{r.deliveries}</td>
                  <td className={cn(TD, 'text-right font-mono')}>{r.suppliers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="shrink-0" style={{ width: CHART_W_PX }}>
          <PrintSeriesChart
            widthPx={CHART_W_PX}
            heightPx={CHART_H_PX}
            points={model.chart.points}
            lineDomain={model.chart.lineDomain}
            lineTicks={model.chart.lineTicks}
            refLine={model.chart.refLine}
            ariaLabel={model.chart.ariaLabel}
          />
          <PrintChartLegend
            entries={[
              { kind: 'line', label: model.chartCaption },
              { kind: 'ref', label: "this lens's basis" },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
