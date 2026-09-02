"use client";

// ─────────────────────────────────────────────────────────────────────────────
// PRINT A WHOLE METRIC GROUP (owner feedback R5)
//
// Renzo: *"print per metric group — every row in that group as its chart card,
// one after another, one consolidated landscape report."*
//
// ── IT REUSES THE PER-METRIC MACHINERY RATHER THAN REPLACING IT ──────────────
// A group print is not a new kind of report. It is the SAME card the per-row
// Print button already produces, rendered once per row, in the group's current
// order, separated by page breaks. `printCard` is unchanged in behaviour and
// the per-metric Print button stays exactly where it was — this is the same
// mechanism given more than one card to carry.
//
// ── WHY THE CARDS ARE RENDERED OFFSTAGE, AND WHY WITH REAL LAYOUT ────────────
// The obvious version — render the sheet with `hidden print:block` — was
// rejected on a measured property of the chart library rather than on taste:
// `display: none` gives an element no box, `ResponsiveContainer` measures its
// parent box, and a print media query does not apply until the print dialog is
// already open. A sheet built that way prints ten empty chart frames.
//
// So the stage is a real, laid-out, 1040 px column parked in a zero-sized
// clipped box: recharts measures it, the charts draw, and nothing is visible on
// screen. When `printCard` runs, the stage becomes a `data-print-ancestor` and
// the print rules flatten it — `position: static`, `width: auto`,
// `overflow: visible` — so what lands on paper is the column, at the top of the
// sheet, exactly as a single card does today.
//
// It is mounted only while a print is in flight and unmounted on `afterprint`.
// Ten recharts instances is a real cost; paying it permanently to serve a
// button nobody has pressed is not.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { printCard } from "./print-card";

/**
 * How long the stage is given to lay out before the dialog opens.
 *
 * `ResponsiveContainer` measures on a `ResizeObserver` callback, which lands
 * after the first paint, and every chart on this page has animation disabled —
 * so what is being waited for is one observer tick, not an animation. 400 ms is
 * several frames of headroom on a slow machine and is imperceptible against the
 * print dialog that follows it.
 */
const LAYOUT_SETTLE_MS = 400;

export interface GroupPrintStageProps {
  /** The report's own name — `RC Inventory`, `Production`, `Grade mix`. */
  title: string;
  /** The window, the granularity, the as-of date. What a reader owes a figure. */
  subtitle: string;
  /** How many cards follow, said on paper so a short report is visibly short. */
  countLabel: string;
  /** One card per row, already in the group's order. */
  children: React.ReactNode;
  /** Unmount me — fired once the dialog has resolved, whichever way. */
  onDone(): void;
}

export function GroupPrintStage({
  title,
  subtitle,
  countLabel,
  children,
  onDone,
}: GroupPrintStageProps) {
  const sheetRef = React.useRef<HTMLDivElement | null>(null);
  // `onDone` unmounts this component, so it must not be able to fire twice —
  // the `afterprint` listener and the fallback timer race by design.
  const doneRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone();
    };

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      printCard(sheetRef.current);
      // The same belt-and-braces `printCard` itself uses: not every engine
      // fires `afterprint` on a dismissed dialog, and a stage left mounted
      // would keep ten charts alive for the rest of the session.
      window.addEventListener("afterprint", finish, { once: true });
      window.setTimeout(finish, 2000);
    }, LAYOUT_SETTLE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finish);
    };
  }, [onDone]);

  return (
    // Zero-sized and clipped on screen; flattened to a plain block by the
    // print rules the moment `printCard` tags it. `aria-hidden` because a
    // second copy of every chart is noise to a screen reader — the cards it
    // duplicates are all on the page already.
    <div aria-hidden className="bw-print-stage">
      <div ref={sheetRef} className="bw-print-sheet flex flex-col">
        {/* Paper only, and the same contract the single-card sheet keeps: a
            printed figure that does not say what it is and when it was true is
            a figure somebody misquotes a month later. */}
        <div className="hidden print:block print:pb-3">
          <h1 className="text-[length:var(--bw-fs-18)] leading-[var(--bw-lh-base)] font-semibold tracking-tight">
            {title}
          </h1>
          <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
            {subtitle}
          </p>
          <p className="text-[length:var(--bw-fs-11)] text-muted-foreground">
            {countLabel} — each on its own page, in the order the group is shown
            on screen.
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * One card of the report. The page break lives here rather than on the card
 * itself, so a card can be printed alone (the per-row button) or in a sequence
 * (this) without knowing which it is in.
 */
export function GroupPrintPage({ children }: { children: React.ReactNode }) {
  return <div data-print-page>{children}</div>;
}
