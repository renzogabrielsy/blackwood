'use client';

// ─────────────────────────────────────────────────────────────────────────────
// THE BLEND DIALOG'S ON-SCREEN MARKET CHART (2026-09-26).
//
// Renzo, after the printed page one: *"The PDF looks great. Now add that chart to our web
// app, in the blend proposal section."* This is the THIRD thin renderer of ONE chart:
//
//   model     `buildBlendMarketChartModel`  (blend-market-chart.ts) — built ONCE by the dialog
//   geometry  `layoutBlendMarketChart`      — the same scales, runs, gaps and partial marks
//   renderers print SVG string · jsPDF primitives · THIS React SVG
//
// The dialog hands this component the SAME model it hands the print, so there is one
// fetch and one set of series; nothing here re-reads, re-scales or re-derives a value.
//
// ── What is screen-only ─────────────────────────────────────────────────────
//   • INK. The print's explicit light ink is swapped for theme tokens (text, axes, grid)
//     and the same four hues tuned per theme (700 on light, 400 on dark), keyed by the
//     series id and the text item's `role` — never by the colour the layout carries.
//   • SIZE. The layout is recomputed at the box's REAL pixel width (ResizeObserver), so a
//     10 px label stays 10 px at any width instead of scaling with a viewBox. On a narrow
//     box the month labels are thinned (every k-th, anchored on the newest month).
//   • INTERACTION. A crosshair tooltip per month (pointer, tap, ←/→ keys) with all four
//     values — ₱/kg to 2 dp, tonnes, "partial", and "no data" for a gap, NEVER 0 — and a
//     legend that toggles series on and off. No animation: nothing here moves but the
//     crosshair, and it jumps.
//   • STATES. `loading` keeps the section's exact height (the plot box is fixed and the
//     legend / definitions / one footnote line are laid out before the data lands).
//     `error` is an inline banner with Copy and Retry (the HARD RULE) — the rest of the
//     dialog is untouched. A read that never answers shows the same banner after 15 s.
//
// ── Price gate ──────────────────────────────────────────────────────────────
// The server nulls both ₱ series for a `!canViewPrices()` reader and the model then has no
// lines, no price axis and no reference line; the tooltip is built from the model, so it
// cannot name a price either. `showPrices` here only predicts the legend while loading.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from 'react';
import { ChevronDown, LineChart } from 'lucide-react';

import { cn } from '@/lib/utils';
import { RefusalBanner } from '../blocking/lens/lens-refusal-banner';
import {
  BLEND_MARKET_AREA_OPACITY,
  BLEND_MARKET_CHART_TITLE,
  BLEND_MARKET_LABEL_PX,
  BLEND_MARKET_SHORT_LABEL,
  blendMarketSlotAt,
  blendMarketSubtitle,
  blendMarketTooltip,
  layoutBlendMarketChart,
  type BlendMarketChartModel,
  type BlendMarketPoint,
  type BlendMarketSeriesId,
  type BlendMarketTextRole,
} from './blend-market-chart';

/** The plot box's fixed height (px). Fixed, so loading → ready never moves the blocks table. */
export const BLEND_MARKET_SCREEN_PLOT_PX = 220;
/** How long a read may stay unanswered before the section says so (it keeps the skeleton). */
const STALL_MS = 15_000;
/** The tooltip's fixed width (px), so its clamped position is deterministic. */
const TOOLTIP_W = 184;
/** Monospace glyph advance as a fraction of the font size, for the layout's label estimate. */
const SCREEN_CHAR_W = 0.62;
const OPEN_KEY = 'bw.blend_market_chart.open';

type LegendId = BlendMarketSeriesId | 'ref';

/** The four hues, tuned per theme; the reference level takes the foreground token. */
const INK: Record<
  LegendId,
  { stroke: string; fill: string; swatch: string; swatchBorder: string }
> = {
  fedPrice: {
    stroke: 'stroke-blue-700 dark:stroke-blue-400',
    fill: 'fill-blue-700 dark:fill-blue-400',
    swatch: 'bg-blue-700 dark:bg-blue-400',
    swatchBorder: 'border-blue-700 dark:border-blue-400',
  },
  deliveredPrice: {
    stroke: 'stroke-orange-700 dark:stroke-orange-400',
    fill: 'fill-orange-700 dark:fill-orange-400',
    swatch: 'bg-orange-700 dark:bg-orange-400',
    swatchBorder: 'border-orange-700 dark:border-orange-400',
  },
  fedVolume: {
    stroke: 'stroke-purple-700 dark:stroke-purple-400',
    fill: 'fill-purple-500 dark:fill-purple-400',
    swatch: 'bg-purple-500/30 dark:bg-purple-400/30',
    swatchBorder: 'border-purple-700 dark:border-purple-400',
  },
  deliveredVolume: {
    stroke: 'stroke-green-700 dark:stroke-green-400',
    fill: 'fill-green-500 dark:fill-green-400',
    swatch: 'bg-green-500/30 dark:bg-green-400/30',
    swatchBorder: 'border-green-700 dark:border-green-400',
  },
  ref: {
    stroke: 'stroke-foreground',
    fill: 'fill-foreground',
    swatch: 'bg-foreground',
    swatchBorder: 'border-foreground',
  },
};

const TEXT_INK: Record<BlendMarketTextRole, string> = {
  leftTick: 'fill-muted-foreground',
  rightTick: 'fill-muted-foreground',
  month: 'fill-muted-foreground',
  partial: 'fill-muted-foreground',
  leftUnit: 'fill-foreground',
  rightUnit: 'fill-foreground',
  ref: 'fill-foreground',
};

/** The legend, in the model's own order: the lines, then the areas, then the reference. */
function legendIds(hasLines: boolean, hasRef: boolean): LegendId[] {
  return [
    ...(hasLines ? (['fedPrice', 'deliveredPrice'] as const) : []),
    'fedVolume',
    'deliveredVolume',
    ...(hasRef ? (['ref'] as const) : []),
  ];
}

function pts(p: readonly BlendMarketPoint[]): string {
  return p.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
}

function Swatch({ id }: { id: LegendId }) {
  const ink = INK[id];
  if (id === 'ref') {
    return <span aria-hidden className={cn('inline-block w-3.5 border-t-[1.5px] border-dashed', ink.swatchBorder)} />;
  }
  if (id === 'fedPrice' || id === 'deliveredPrice') {
    return <span aria-hidden className={cn('inline-block h-[2.5px] w-3.5 rounded-full', ink.swatch)} />;
  }
  return <span aria-hidden className={cn('inline-block h-2 w-3 rounded-[2px] border', ink.swatch, ink.swatchBorder)} />;
}

/** The box's width, kept current by a ResizeObserver (its first callback measures). */
function useBoxWidth<T extends HTMLElement>(): [React.RefCallback<T>, number] {
  const [width, setWidth] = React.useState(0);
  const roRef = React.useRef<ResizeObserver | null>(null);
  const ref = React.useCallback((node: T | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(node);
    roRef.current = ro;
  }, []);
  return [ref, width];
}

export interface BlendMarketChartScreenProps {
  /** The dialog's market read lifecycle. */
  state: 'loading' | 'ready' | 'error';
  /** THE model the print draws (null until `ready`). */
  model: BlendMarketChartModel | null;
  errorMessage?: string | null;
  /** The EFFECTIVE price flag — only used to lay the legend out before the data lands. */
  showPrices: boolean;
  /** Whether the blend's own raw ₱/kg will ride as a reference line (legend prediction). */
  expectRefLine: boolean;
  /** Changes on every new read (anchor + retry), so a stale "still loading" never lingers. */
  loadKey: string;
  onRetry: () => void;
}

export function BlendMarketChartScreen({
  state,
  model,
  errorMessage,
  showPrices,
  expectRefLine,
  loadKey,
  onRetry,
}: BlendMarketChartScreenProps) {
  // ── Open / collapsed: a per-viewer convenience, so browser storage and try/catch ──
  const [open, setOpen] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      return window.localStorage.getItem(OPEN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggleOpen = React.useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(OPEN_KEY, next ? '1' : '0');
      } catch {
        // Blocked store — the choice still holds for this session.
      }
      return next;
    });
  }, []);

  // ── Stall watchdog: a read that never answers says so, keeping the skeleton ──
  const [stalledKey, setStalledKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (state !== 'loading') return;
    const t = setTimeout(() => setStalledKey(loadKey), STALL_MS);
    return () => clearTimeout(t);
  }, [state, loadKey]);
  const stalled = state === 'loading' && stalledKey === loadKey;

  const [boxRef, width] = useBoxWidth<HTMLDivElement>();
  const [hidden, setHidden] = React.useState<ReadonlySet<LegendId>>(() => new Set());
  const [active, setActive] = React.useState<number | null>(null);

  const ready = state === 'ready' && model !== null;
  const hasLines = ready ? model.lines.length > 0 : showPrices;
  const hasRef = ready ? model.refLine !== null : showPrices && expectRefLine;
  const legend = legendIds(hasLines, hasRef);
  const subtitle = ready ? model.subtitle : blendMarketSubtitle(showPrices);

  const layout = React.useMemo(() => {
    if (!ready || width < 40) return null;
    return layoutBlendMarketChart(model, width, BLEND_MARKET_SCREEN_PLOT_PX, BLEND_MARKET_LABEL_PX, SCREEN_CHAR_W);
  }, [ready, model, width]);

  // A narrow box keeps every k-th month label, anchored on the NEWEST month (the partial one).
  const n = layout?.slotX.length ?? 0;
  const monthStep = React.useMemo(() => {
    if (!layout || n === 0) return 1;
    const slotW = layout.plot.w / n;
    const labelW = 7 * BLEND_MARKET_LABEL_PX * SCREEN_CHAR_W + 6;
    return Math.max(1, Math.ceil(labelW / slotW));
  }, [layout, n]);
  const showMonth = (slot: number | undefined) =>
    slot === undefined || (n - 1 - slot) % monthStep === 0;

  const activeSlot = active !== null && active < n ? active : null;
  const tip = ready && activeSlot !== null ? blendMarketTooltip(model, activeSlot) : null;
  const tipRows = tip ? tip.rows.filter((r) => !hidden.has(r.id)) : [];

  const toggleSeries = (id: LegendId) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onPointer = (e: React.PointerEvent<SVGRectElement>) => {
    if (!layout) return;
    const svg = e.currentTarget.ownerSVGElement;
    if (!svg) return;
    const x = e.clientX - svg.getBoundingClientRect().left;
    setActive(blendMarketSlotAt(layout, x));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!layout || n === 0) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      setActive((prev) => (prev === null ? (d > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, prev + d))));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : n - 1);
    } else if (e.key === 'Escape' && activeSlot !== null) {
      e.stopPropagation(); // close the tooltip, not the dialog
      setActive(null);
    }
  };

  // Tooltip position: beside the crosshair, flipped past the midpoint, clamped to the box.
  let tipLeft = 0;
  if (layout && activeSlot !== null) {
    const x = layout.slotX[activeSlot];
    const raw = x > width / 2 ? x - 10 - TOOLTIP_W : x + 10;
    tipLeft = Math.max(0, Math.min(width - TOOLTIP_W, raw));
  }

  return (
    <section
      className="space-y-1"
      data-blend-market-screen
      data-state={state}
      data-prices={ready ? (model.showPrices ? '1' : '0') : showPrices ? '1' : '0'}
    >
      {/* ── Heading (the collapse toggle) ── */}
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        data-blend-market-toggle
        className="flex w-full items-baseline gap-1.5 border-b border-border pb-1 text-left cursor-pointer group"
      >
        <LineChart className="w-3.5 h-3.5 text-primary shrink-0 self-center" />
        <span className="text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap text-muted-foreground group-hover:text-foreground transition-colors duration-150">
          {BLEND_MARKET_CHART_TITLE}
        </span>
        {ready && model.range && (
          <span className="min-w-0 text-[10px] font-mono text-muted-foreground truncate">{model.range}</span>
        )}
        <ChevronDown
          className={cn(
            'ml-auto w-3.5 h-3.5 shrink-0 self-center text-muted-foreground transition-transform duration-150',
            !open && '-rotate-90',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-1">
          {/* ── Legend (toggles) — the same entries while loading, so nothing reflows ── */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 min-h-[18px]" data-blend-market-legend>
            {legend.map((id) => {
              const on = !hidden.has(id);
              const full =
                ready && id !== 'ref'
                  ? [...model.lines, ...model.areas].find((s) => s.id === id)?.label
                  : ready && id === 'ref'
                    ? model.legend.find((e) => e.kind === 'ref')?.label
                    : undefined;
              return (
                <button
                  key={id}
                  type="button"
                  disabled={!ready}
                  onClick={() => toggleSeries(id)}
                  aria-pressed={on}
                  data-market-legend={id}
                  title={full ? `${full} — click to ${on ? 'hide' : 'show'}` : undefined}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-sm px-0.5 text-[10px] leading-[18px] text-foreground whitespace-nowrap',
                    'cursor-pointer disabled:cursor-default hover:bg-muted transition-opacity duration-150',
                    (!on || !ready) && 'opacity-45',
                  )}
                >
                  <Swatch id={id} />
                  {BLEND_MARKET_SHORT_LABEL[id]}
                </button>
              );
            })}
          </div>

          {/* ── The plot box: FIXED height in every state ── */}
          {state === 'error' ? (
            <RefusalBanner
              message={`Market history unavailable. ${errorMessage ?? 'The read failed.'} The blend itself is unaffected.`}
              onRetry={onRetry}
            />
          ) : (
            <>
              {stalled && (
                <RefusalBanner
                  message="The twelve-month market history has not come back yet. The blend itself is unaffected — retry, or copy this and send it on if it keeps happening."
                  onRetry={onRetry}
                />
              )}
              <div
                ref={boxRef}
                // h-[220px] === BLEND_MARKET_SCREEN_PLOT_PX (a class, not a style — pinned by
                // scripts/verify-blend-market-screen.ts).
                className="relative h-[220px] w-full min-w-[280px] outline-none rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
                data-blend-market-plot
                tabIndex={ready ? 0 : -1}
                role="group"
                aria-label={ready ? `${model.ariaLabel}. Use the left and right arrow keys to read a month.` : 'Market history loading'}
                onKeyDown={onKeyDown}
                onBlur={() => setActive(null)}
              >
                {!ready && (
                  <div
                    className="absolute inset-0 rounded-md border border-border bg-muted/40 animate-pulse"
                    aria-hidden
                    data-blend-market-skeleton
                  />
                )}
                {layout && (
                  <svg
                    width={layout.width}
                    height={layout.height}
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    className="absolute inset-0 block overflow-visible select-none"
                    role="img"
                    aria-label={model?.ariaLabel}
                    data-blend-market-svg
                  >
                    {/* Guides */}
                    {layout.guides.map((gy, i) => (
                      <line
                        key={`g${i}`}
                        x1={layout.plot.x}
                        x2={layout.plot.x + layout.plot.w}
                        y1={gy}
                        y2={gy}
                        className="stroke-border"
                        strokeWidth={1}
                      />
                    ))}

                    {/* The active month's column, behind the series */}
                    {activeSlot !== null && (
                      <rect
                        x={layout.plot.x + (layout.plot.w / n) * activeSlot}
                        y={layout.plot.y}
                        width={layout.plot.w / n}
                        height={layout.plot.h}
                        className="fill-foreground/5"
                      />
                    )}

                    {/* Areas, behind everything else */}
                    {layout.areas
                      .filter((a) => !hidden.has(a.id))
                      .flatMap((a) =>
                        a.polygons.map((poly, pi) => (
                          <polygon
                            key={`${a.id}${pi}`}
                            data-series={a.id}
                            points={pts(poly)}
                            className={cn(INK[a.id].fill, INK[a.id].stroke)}
                            fillOpacity={BLEND_MARKET_AREA_OPACITY}
                            strokeWidth={1.1}
                            strokeLinejoin="round"
                          />
                        )),
                      )}

                    {/* Baseline */}
                    <line
                      x1={layout.plot.x}
                      x2={layout.plot.x + layout.plot.w}
                      y1={layout.baselineY}
                      y2={layout.baselineY}
                      className="stroke-muted-foreground"
                      strokeWidth={1}
                    />

                    {/* The blend's own level */}
                    {layout.ref && !hidden.has('ref') && (
                      <line
                        data-series="ref"
                        x1={layout.ref.x1}
                        x2={layout.ref.x2}
                        y1={layout.ref.y}
                        y2={layout.ref.y}
                        className={INK.ref.stroke}
                        strokeWidth={1}
                        strokeDasharray="5 3"
                      />
                    )}

                    {/* Lines + dots (hollow = the partial month) */}
                    {layout.lines
                      .filter((ln) => !hidden.has(ln.id))
                      .map((ln) => (
                        <g key={ln.id}>
                          {ln.runs
                            .filter((run) => run.length > 1)
                            .map((run, ri) => (
                              <polyline
                                key={ri}
                                data-series={ln.id}
                                points={pts(run)}
                                fill="none"
                                className={INK[ln.id].stroke}
                                strokeWidth={2}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                              />
                            ))}
                          {ln.dots.map((d, di) => (
                            <circle
                              key={di}
                              data-series={ln.id}
                              data-partial={d.hollow ? '1' : undefined}
                              cx={d.x}
                              cy={d.y}
                              r={d.hollow ? 3.2 : 2.6}
                              className={cn(INK[ln.id].stroke, d.hollow ? 'fill-background' : INK[ln.id].fill)}
                              strokeWidth={d.hollow ? 1.6 : 0}
                            />
                          ))}
                        </g>
                      ))}

                    {/* Crosshair + the hovered month's points ringed */}
                    {activeSlot !== null && (
                      <g data-blend-market-crosshair>
                        <line
                          x1={layout.slotX[activeSlot]}
                          x2={layout.slotX[activeSlot]}
                          y1={layout.plot.y}
                          y2={layout.baselineY}
                          className="stroke-muted-foreground"
                          strokeWidth={1}
                          strokeDasharray="3 3"
                        />
                        {layout.lines
                          .filter((ln) => !hidden.has(ln.id))
                          .flatMap((ln) =>
                            ln.dots
                              .filter((d) => Math.abs(d.x - layout.slotX[activeSlot]) < 0.5)
                              .map((d) => (
                                <circle
                                  key={ln.id}
                                  cx={d.x}
                                  cy={d.y}
                                  r={4.8}
                                  className={cn(INK[ln.id].stroke, 'fill-background')}
                                  strokeWidth={2}
                                />
                              )),
                          )}
                      </g>
                    )}

                    {/* Labels — inked by ROLE, never by the print's colour */}
                    {layout.texts
                      .filter((t) => (t.role === 'month' || t.role === 'partial' ? showMonth(t.slot) : true))
                      .filter((t) => !(t.role === 'ref' && hidden.has('ref')))
                      .map((t, i) => (
                        <text
                          key={`t${i}`}
                          x={t.x}
                          y={t.y}
                          fontSize={t.size}
                          textAnchor={t.anchor}
                          fontWeight={t.bold ? 700 : undefined}
                          fontStyle={t.italic ? 'italic' : undefined}
                          className={cn('font-mono', TEXT_INK[t.role])}
                          data-role={t.role}
                        >
                          {t.text}
                        </text>
                      ))}

                    {/* The hit area: the whole plot, one month per slot */}
                    <rect
                      x={layout.plot.x}
                      y={0}
                      width={layout.plot.w}
                      height={layout.height}
                      fill="transparent"
                      className="cursor-crosshair touch-pan-y"
                      data-blend-market-hit
                      onPointerMove={onPointer}
                      onPointerDown={onPointer}
                      onPointerLeave={(e) => {
                        if (e.pointerType === 'mouse') setActive(null);
                      }}
                    />
                  </svg>
                )}

                {/* The tooltip — every visible series for the month, "no data" for a gap */}
                {tip && layout && (
                  <div
                    role="tooltip"
                    data-blend-market-tooltip
                    data-slot={activeSlot ?? undefined}
                    // w-[184px] === TOOLTIP_W; only `left` is dynamic (the crosshair's x).
                    className="pointer-events-none absolute top-1 z-10 w-[184px] rounded-md border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-md"
                    style={{ left: tipLeft }}
                  >
                    <div className="flex items-baseline justify-between gap-2 border-b border-border pb-0.5 mb-1">
                      <span className="text-[11px] font-semibold" data-tip-month>
                        {tip.month}
                      </span>
                      {tip.partial && (
                        <span className="text-[9px] italic text-muted-foreground" data-tip-partial>
                          partial
                        </span>
                      )}
                    </div>
                    {tipRows.length === 0 ? (
                      <div className="text-[10px] italic text-muted-foreground">Every series is hidden</div>
                    ) : (
                      tipRows.map((r) => (
                        <div key={r.id} className="flex items-center justify-between gap-2 text-[10px] leading-4" data-tip-row={r.id}>
                          <span className="inline-flex items-center gap-1 text-muted-foreground whitespace-nowrap">
                            <Swatch id={r.id} />
                            {r.label}
                          </span>
                          {r.text === null ? (
                            <span className="italic text-muted-foreground" data-tip-value>
                              no data
                            </span>
                          ) : (
                            <span className="font-mono font-semibold text-foreground whitespace-nowrap" data-tip-value>
                              {r.text}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── Definitions + footnotes: one reserved line, so a loaded read does not reflow ── */}
          <div className="text-[10px] leading-snug text-muted-foreground space-y-0.5" data-blend-market-notes>
            <p>{subtitle}</p>
            <ul className="min-h-[15px] list-none p-0 m-0">
              {ready &&
                model.footnotes.map((f) => (
                  <li key={f} data-blend-market-footnote>
                    {f}
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
