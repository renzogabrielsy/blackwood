"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE STYLE POPOVER — one colour and one stroke per YEAR (owner feedback R9).
//
// Renzo: *"each year be represented by a line — solid line, dotted, area line,
// etc of differing colors (which we can also customize and set)"*.
//
// ── WHY IT SITS BESIDE `Years` AND NOT INSIDE THE LEGEND ────────────────────
// The same reasoning R3 wrote down for the average toggle: a legend swatch is a
// ~10 px target inside the SVG, it looks exactly like the static legend it has
// always been, and it lives INSIDE the print card. So the CONTROL is a labelled
// trigger in the header's `data-print-hide` span, exactly like `Years` and the
// chart toggles it sits with, and the legend keeps its own smaller job —
// showing the style and switching a year off (R9 wires that, because toggling
// what is already drawn is a different act from configuring it).
//
// ── THE PICKER OFFERS THE PALETTE FIRST AND A FREE COLOUR SECOND ────────────
// The eight swatches are the validated categorical slots (see
// `lib/analytics/year-overlay.ts` and the `--bw-year-*` block in `globals.css`):
// picking one of those keeps every CVD, contrast and print property the default
// palette was checked for. The native colour input is deliberately AFTER them
// and unlabelled as a recommendation — it is the reader's own choice, and a
// choice the page cannot validate is offered rather than encouraged.
//
// A `<style>`-attribute colour that came out of `localStorage` is validated by
// `parseYearStyles` before it is ever read back, which is where that rule is
// enforced rather than here.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Palette, RotateCcw } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  YEAR_DASH,
  YEAR_LINE_STYLES,
  YEAR_LINE_STYLE_LABEL,
  YEAR_SWATCHES,
  resolveYearStyle,
  type YearLineStyle,
  type YearStyleMap,
} from "@/lib/analytics/year-overlay";

/**
 * `var(--bw-year-3)` → `#1baf7a`, for the native colour input, which only
 * accepts a hex. Read off the document element so it follows the live theme.
 * Wrapped: a browser that will not answer gives the input a harmless default
 * rather than throwing inside a popover.
 */
function resolveCssColor(value: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  const m = /^var\((--[a-zA-Z0-9-]+)\)$/.exec(value.trim());
  if (!m || typeof window === "undefined") return "#2a78d6";
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(m[1])
      .trim();
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : "#2a78d6";
  } catch {
    return "#2a78d6";
  }
}

/** A 26×8 preview of one stroke — the control shows the line it makes. */
export function StrokePreview({
  color,
  style,
  width = 26,
  className,
}: {
  color: string;
  style: YearLineStyle;
  width?: number;
  className?: string;
}) {
  const dash = YEAR_DASH[style];
  return (
    <svg
      aria-hidden
      width={width}
      height={8}
      viewBox={`0 0 ${width} 8`}
      className={cn("shrink-0 overflow-visible", className)}
    >
      {style === "area" && (
        <path
          d={`M0 4 L${width} 4 L${width} 8 L0 8 Z`}
          fill={color}
          fillOpacity={0.25}
        />
      )}
      <path
        d={`M0 4 L${width} 4`}
        stroke={color}
        strokeWidth={2}
        strokeDasharray={dash}
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export interface YearStyleMenuProps {
  /** The years on the axis, ascending — the same list the legend draws. */
  years: readonly number[];
  styles: YearStyleMap;
  onColor(year: number, color: string | null): void;
  onStyle(year: number, style: YearLineStyle | null): void;
  onResetYear(year: number): void;
  onResetAll(): void;
  customised: boolean;
  align?: "start" | "end";
}

export function YearStyleMenu({
  years,
  styles,
  onColor,
  onStyle,
  onResetYear,
  onResetAll,
  customised,
  align = "end",
}: YearStyleMenuProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Set the colour and the line style of each year. The eight swatches are the page's checked palette — each pair is distinguishable in both themes and to a colour-blind reader; the picker beside them is your own colour. Your choice is remembered in this browser and applies to every chart on the page."
          aria-label={`Style — ${years.length} year${years.length === 1 ? "" : "s"}`}
          className={cn(
            "inline-flex h-[var(--an-h-8)] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] font-medium",
            "transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            customised
              ? "border-border bg-background text-foreground shadow-sm"
              : "border-border/60 bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          <Palette className="size-3.5" aria-hidden />
          Style
        </button>
      </PopoverTrigger>

      <PopoverContent
        align={align}
        side="bottom"
        sideOffset={6}
        collisionPadding={12}
        // `bw-analytics` because Radix portals this to <body>, outside the shell
        // div carrying the page scale — the same reason `period-filter.tsx`
        // does it.
        className="bw-analytics max-h-[var(--radix-popover-content-available-height)] w-[min(300px,calc(100vw-2rem))] overflow-hidden p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
          <span className="truncate text-[length:var(--bw-fs-11)] font-medium uppercase tracking-wide text-muted-foreground">
            Year style
          </span>
          <button
            type="button"
            onClick={onResetAll}
            disabled={!customised}
            title="Put every year back to the page's checked palette."
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border/70 px-1.5 py-0.5 text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <RotateCcw className="size-2.5" aria-hidden />
            Reset
          </button>
        </div>

        <div className="max-h-[280px] overflow-y-auto">
          {years.length === 0 ? (
            <p className="px-2.5 py-3 text-center text-[length:var(--bw-fs-11)] text-muted-foreground">
              No years on the chart.
            </p>
          ) : (
            years.map((year) => {
              const resolved = resolveYearStyle(year, styles);
              return (
                <div
                  key={year}
                  className="flex flex-col gap-1 border-b border-border/50 px-2.5 py-2 last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <StrokePreview color={resolved.color} style={resolved.style} />
                    <span className="flex-1 font-mono text-[length:var(--bw-fs-12)] tabular-nums">
                      {year}
                    </span>
                    <span className="text-[length:var(--bw-fs-10)] text-muted-foreground">
                      {YEAR_LINE_STYLE_LABEL[resolved.style]}
                    </span>
                    <button
                      type="button"
                      onClick={() => onResetYear(year)}
                      disabled={!resolved.customised}
                      title={`Put ${year} back to the palette default.`}
                      className="cursor-pointer rounded p-0.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      <RotateCcw className="size-2.5" aria-hidden />
                    </button>
                  </div>

                  {/* The checked palette first. */}
                  <div className="flex flex-wrap items-center gap-1">
                    {YEAR_SWATCHES.map((s) => (
                      <button
                        key={s.token}
                        type="button"
                        aria-label={`${year} — ${s.name}`}
                        aria-pressed={resolved.color === s.token}
                        title={`${s.name} — one of the page's checked palette slots.`}
                        onClick={() => onColor(year, s.token)}
                        className={cn(
                          "size-4 cursor-pointer rounded-[3px] border transition-transform duration-150 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          resolved.color === s.token
                            ? "border-foreground"
                            : "border-border/60",
                        )}
                        style={{ background: s.token }}
                      />
                    ))}
                    <label
                      title="Any colour you like. Outside the checked palette, so its contrast and colour-blind separation are your call — the line style beside it still tells the years apart."
                      className="ml-0.5 inline-flex size-4 cursor-pointer items-center justify-center rounded-[3px] border border-dashed border-border/80"
                    >
                      <Palette
                        className="size-2.5 text-muted-foreground"
                        aria-hidden
                      />
                      <input
                        type="color"
                        aria-label={`${year} — custom colour`}
                        value={resolveCssColor(resolved.color)}
                        onChange={(e) => onColor(year, e.target.value)}
                        className="sr-only"
                      />
                    </label>
                  </div>

                  {/* The stroke, drawn rather than named. */}
                  <div className="flex flex-wrap items-center gap-1">
                    {YEAR_LINE_STYLES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        aria-label={`${year} — ${YEAR_LINE_STYLE_LABEL[s]}`}
                        aria-pressed={resolved.style === s}
                        title={
                          s === "area"
                            ? "Fill under the line. Useful for one year on its own; two filled years hide each other, which is why it is never a default."
                            : `${YEAR_LINE_STYLE_LABEL[s]} — the stroke is what tells the years apart on a printed, colourless sheet.`
                        }
                        onClick={() => onStyle(year, s)}
                        className={cn(
                          "inline-flex h-5 cursor-pointer items-center rounded border px-1.5 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          resolved.style === s
                            ? "border-foreground bg-muted/60"
                            : "border-border/60 hover:bg-muted/40",
                        )}
                      >
                        <StrokePreview
                          color={resolved.color}
                          style={s}
                          width={s === "area" ? 14 : 20}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <p className="border-t px-2.5 py-1.5 text-[length:var(--bw-fs-105)] leading-relaxed text-muted-foreground">
          Remembered in this browser and applied to every chart on the page.
          Styling changes what a line LOOKS like and never what it says.
        </p>
      </PopoverContent>
    </Popover>
  );
}
