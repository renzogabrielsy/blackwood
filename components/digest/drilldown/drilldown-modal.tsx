"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE DRILL-DOWN CHASSIS — a reusable "expand this tile" modal.
//
// Any digest card can adopt it. The whole adoption is FIVE lines:
//
//     const dd = useDrilldown(getRcOutDrilldown);            // 1
//     …
//     <button onClick={dd.open}>{ the existing tile }</button>  // 2
//     <DrilldownModal {...dd.modalProps} title="RC Out"        // 3
//       skeleton={<DrilldownChartSkeleton />}                   // 4
//     >{dd.data && <RcOutBody data={dd.data} />}</DrilldownModal> // 5
//
// The chassis owns: the glass Dialog shell, esc / scroll-lock / focus trap
// (Radix), the range toggle, the OPEN-FIRST contract (skeleton on the click
// frame, `animate-fade-in` when data lands), the persistent copyable failure
// banner with Retry, and the footer "open the module" link. A caller owns only
// the BODY and the fetcher.
//
// GLASS — `DialogContent`'s own base already IS the project's canonical modal
// glass (`bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80`),
// so it is inherited, not re-declared.
//
// ENTRANCE — deliberately Radix's own `data-[state=open]:animate-in fade-in-0
// zoom-in-95`, NOT the `animate-modal-enter` utility. They are the same visual
// (fade + scale from 0.95) but they set the same `animation` shorthand, and
// `.animate-modal-enter` lives OUTSIDE Tailwind's `@layer utilities` in
// globals.css — so it would win the cascade unconditionally, taking the
// `data-[state=closed]` EXIT animation with it and making the modal snap shut.
// One entrance animation, owned by the primitive.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { AlertTriangle, ArrowRight, Copy, RotateCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/shared/detail-drawer-skeleton";
import { cn } from "@/lib/utils";
import {
  RANGE_SHORT,
  type DrilldownRange,
} from "@/lib/digest/drilldown-types";
import type { DrilldownModalState } from "./use-drilldown";

const RANGES: DrilldownRange[] = ["30d", "90d", "ytd"];

/** Fixed bar heights for the chart skeleton. LITERAL class strings (Tailwind
 *  only generates what it can see) and DETERMINISTIC — a skeleton that
 *  re-randomizes would twitch on every parent re-render. */
const SKELETON_BARS = [
  "h-[38%]", "h-[64%]", "h-[52%]", "h-[81%]", "h-[46%]", "h-[70%]",
  "h-[33%]", "h-[58%]", "h-[88%]", "h-[49%]", "h-[62%]", "h-[41%]",
  "h-[75%]", "h-[55%]", "h-[36%]", "h-[68%]", "h-[84%]", "h-[47%]",
  "h-[59%]", "h-[43%]", "h-[72%]", "h-[51%]", "h-[65%]", "h-[39%]",
];

// ---------------------------------------------------------------------
// Shared chart chrome — intentionally the same tokens `digest-charts.tsx`
// uses, so an expanded chart reads as the BIG version of the small one
// rather than as a different product.
// ---------------------------------------------------------------------

export const DRILLDOWN_AXIS_TICK = {
  fill: "var(--muted-foreground)",
  // A recharts tick is an SVG <text>, so this can be any CSS length string —
  // and reading the ambient type scale (2026-09-02) is what lets an analytics
  // chart's axis grow with the rest of the page on a wide screen. Unset — the
  // Home Digest — it resolves to the 10px it has always been.
  fontSize: "var(--bw-fs-10, 10px)",
  fontFamily: "var(--font-geist-sans, inherit)",
};

export function drilldownTooltipChrome() {
  return {
    contentStyle: {
      background: "var(--popover)",
      border: "1px solid var(--border)",
      borderRadius: "0.5rem",
      fontSize: "var(--bw-fs-11, 11px)",
      color: "var(--popover-foreground)",
      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
    } as React.CSSProperties,
    labelStyle: {
      color: "var(--muted-foreground)",
      fontSize: "var(--bw-fs-10, 10px)",
    },
    itemStyle: { color: "var(--popover-foreground)" },
    cursor: { stroke: "var(--border)", strokeWidth: 1 },
  };
}

// ---------------------------------------------------------------------
// Range toggle
// ---------------------------------------------------------------------

function RangeToggle({
  range,
  onRangeChange,
  disabled,
}: {
  range: DrilldownRange;
  onRangeChange: (r: DrilldownRange) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Range"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-muted/40 p-0.5"
    >
      {RANGES.map((r) => {
        const active = r === range;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => !active && onRangeChange(r)}
            className={cn(
              "rounded px-2 py-1 text-[11px] font-medium transition-colors duration-150",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              disabled && "cursor-not-allowed opacity-60"
            )}
          >
            {RANGE_SHORT[r]}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------
// Skeleton — CHART-SHAPED, and sized to the real body so the swap does not
// jump. Opacity-only pulse (compositor-safe, reduced-motion neutralized) via
// the shared platform `Skeleton` primitive.
// ---------------------------------------------------------------------

export function DrilldownChartSkeleton({
  /** stat cells in the summary strip (default 4) */
  stats = 4,
  /** render a side rail placeholder (the by-supplier column) */
  sideRail = false,
  /** placeholder rows for the table section (0 = no table) */
  tableRows = 0,
}: {
  stats?: number;
  sideRail?: boolean;
  tableRows?: number;
}) {
  return (
    <div aria-busy className="flex flex-col gap-4">
      {/* summary strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: stats }).map((_, i) => (
          <div key={i} className="rounded-lg border px-3 py-2">
            <Skeleton className="h-[11px] w-16" />
            <Skeleton className="mt-1.5 h-5 w-24" />
          </div>
        ))}
      </div>

      {/* chart (+ optional side rail) */}
      <div
        className={cn("grid grid-cols-1 gap-3", sideRail && "lg:grid-cols-[1fr_280px]")}
      >
        <div className="rounded-lg border p-3">
          <Skeleton className="h-3.5 w-40" />
          <div className="mt-3 flex h-[240px] items-end gap-1.5">
            {Array.from({ length: SKELETON_BARS.length }).map((_, i) => (
              <Skeleton
                key={i}
                className={cn("flex-1 rounded-sm", SKELETON_BARS[i])}
              />
            ))}
          </div>
        </div>
        {sideRail && (
          <div className="rounded-lg border p-3">
            <Skeleton className="h-3.5 w-32" />
            <div className="mt-3 flex flex-col gap-2.5">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-14" />
                  </div>
                  <Skeleton className="mt-1 h-1.5 w-full rounded-full" />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* table */}
      {tableRows > 0 && (
        <div className="rounded-lg border">
          <div className="border-b px-3 py-2">
            <Skeleton className="h-3.5 w-36" />
          </div>
          {Array.from({ length: tableRows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-2 border-b px-3 py-1.5 last:border-0"
            >
              <Skeleton className="h-3 w-20 shrink-0" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-16 shrink-0" />
              <Skeleton className="h-3 w-12 shrink-0" />
              <Skeleton className="h-3 w-16 shrink-0" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Failure — persistent, copyable, retryable (project HARD RULE)
// ---------------------------------------------------------------------

function DrilldownErrorState({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const fullText = `Could not load ${title}\n\n${message}`;

  function handleCopy() {
    void navigator.clipboard.writeText(fullText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div
      role="alert"
      className="animate-fade-in rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-foreground">
            Could not load {title}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {message}
          </p>
          <div className="mt-2 flex items-center gap-1.5">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[10px] text-primary-foreground transition-all duration-150 hover:bg-primary/90"
              >
                <RotateCw className="h-2.5 w-2.5" />
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-all duration-150 hover:bg-muted hover:text-foreground"
            >
              <Copy className="h-2.5 w-2.5" />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Small shared body pieces
// ---------------------------------------------------------------------

/** One cell of the summary stat strip. */
export function DrilldownStat({
  label,
  value,
  unit,
  unitSide = "right",
  sub,
  tone = "default",
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  /**
   * Where the unit sits. Defaults to `"right"`, which is every existing caller
   * and every digest tile — nothing moved.
   *
   * `"left"` pins the unit to the left edge and the number to the right, the
   * project's accounting format (CLAUDE.md → Currency). `/analytics` reads its
   * stat strips that way so a strip and the table under it announce a unit in
   * the same place; a tile that stands alone has no column to line up with and
   * keeps the trailing form.
   */
  unitSide?: "left" | "right";
  sub?: string;
  tone?: "default" | "muted" | "up" | "down";
  title?: string;
}) {
  const valueEl = (
    <span
      className={cn(
        "truncate font-mono text-[length:var(--bw-fs-18,1.125rem)] font-semibold tabular-nums leading-none",
        tone === "muted" && "text-muted-foreground",
        tone === "up" && "text-emerald-700 dark:text-emerald-300",
        tone === "down" && "text-red-700 dark:text-red-300"
      )}
    >
      {value}
    </span>
  );
  const unitEl = unit ? (
    <span className="shrink-0 text-[length:var(--bw-fs-105,10.5px)] text-muted-foreground">
      {unit}
    </span>
  ) : null;
  return (
    <div className="min-w-0 rounded-lg border bg-card/60 px-3 py-2" title={title}>
      <div className="truncate text-[length:var(--bw-fs-105,10.5px)] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 flex items-baseline gap-1",
          unitEl && unitSide === "left" && "justify-between",
        )}
      >
        {unitSide === "left" ? (
          <>
            {unitEl}
            {valueEl}
          </>
        ) : (
          <>
            {valueEl}
            {unitEl}
          </>
        )}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-[length:var(--bw-fs-105,10.5px)] text-muted-foreground">
          {sub}
        </div>
      )}
    </div>
  );
}

/** A titled panel inside the modal body. */
export function DrilldownSection({
  title,
  subtitle,
  action,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  subtitle?: string;
  /**
   * An optional control in the card header, right of the subtitle — the
   * analytics row expand's year checklist (owner feedback R2) mounts here.
   * Purely additive: omitted, the header renders exactly as it always has.
   */
  action?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn("flex min-w-0 flex-col rounded-lg border bg-card/60", className)}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <h4 className="min-w-0 truncate text-[length:var(--bw-fs-12,0.75rem)] font-semibold leading-[var(--bw-lh-xs,1rem)] tracking-tight">
          {title}
        </h4>
        <span className="flex shrink-0 items-center gap-2">
          {subtitle && (
            <span className="text-[length:var(--bw-fs-105,10.5px)] text-muted-foreground">
              {subtitle}
            </span>
          )}
          {action}
        </span>
      </header>
      <div className={cn("min-w-0 p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------

/** One footer destination — the owning module, or the room this tile belongs to. */
export interface DrilldownFooterLink {
  href: string;
  label: string;
}

export interface DrilldownModalProps extends DrilldownModalState {
  title: string;
  /** one line under the title — the window, the unit, the source */
  description?: string;
  /** shown while a request is in flight; defaults to the chart skeleton */
  skeleton?: React.ReactNode;
  /**
   * Bottom-left link(s). ONE is the owning module ("Open RC IN"); an ARRAY adds
   * the month-on-month room beside it ("Full analytics"), because a drill-down
   * answers "what happened in this window" and `/analytics` answers "what has
   * been happening" — a tile that can only reach its own ledger leaves the
   * second question with no door.
   *
   * Widened from a single object rather than replaced: every existing caller
   * passes one and is byte-identical.
   */
  footerLink?: DrilldownFooterLink | readonly DrilldownFooterLink[];
  /** small muted note pinned bottom-right (e.g. a population caveat) */
  footerNote?: string | null;
  /** the loaded body. Rendered only when `loading` and `error` are both falsy. */
  children: React.ReactNode;
}

export function DrilldownModal({
  open,
  onOpenChange,
  range,
  onRangeChange,
  loading,
  error,
  onRetry,
  title,
  description,
  skeleton,
  footerLink,
  footerNote,
  children,
}: DrilldownModalProps) {
  const links: readonly DrilldownFooterLink[] = footerLink
    ? Array.isArray(footerLink)
      ? footerLink
      : [footerLink as DrilldownFooterLink]
    : [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Near-full on a phone (the base max-w already clamps to the viewport
        // minus the safe-area insets); ~min(960px, 92vw) from `sm` up.
        className="flex max-h-[88dvh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(960px,92vw)]"
      >
        {/* Sticky-ish header. The range toggle lives OUTSIDE the body so it
            stays usable while a request is in flight. */}
        <DialogHeader className="shrink-0 gap-1 border-b bg-background/90 px-4 py-3 text-left backdrop-blur-sm sm:px-5">
          {/* Wraps rather than crushes: on a narrow phone the range toggle
              drops to its own row instead of squeezing the title. */}
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 pr-7">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base">{title}</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {description ?? " "}
              </DialogDescription>
            </div>
            <RangeToggle range={range} onRangeChange={onRangeChange} />
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {error ? (
            <DrilldownErrorState
              title={title}
              message={error}
              onRetry={onRetry}
            />
          ) : loading ? (
            (skeleton ?? <DrilldownChartSkeleton />)
          ) : (
            // Opacity-only, 150ms, no layout shift — React reuses the same
            // section nodes across the skeleton→data swap.
            <div className="animate-fade-in">{children}</div>
          )}
        </div>

        {(links.length > 0 || footerNote) && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-background/90 px-4 py-2.5 backdrop-blur-sm sm:px-5">
            {links.length > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    className="inline-flex items-center gap-1 rounded text-xs font-medium text-foreground transition-colors duration-150 hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {link.label}
                    <ArrowRight className="size-3" />
                  </a>
                ))}
              </div>
            ) : (
              <span />
            )}
            {footerNote && (
              <span className="min-w-0 text-[10.5px] leading-snug text-muted-foreground">
                {footerNote}
              </span>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
