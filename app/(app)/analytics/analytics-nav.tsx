"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE IN-PAGE ANCHOR ROW — five destinations for a page that runs several
// screens.
//
// P4 completes the page, and completion is what makes it long: the matrix's two
// bands, the campaign panel, the supplier room, the production room and the
// watchlist. A reader who wants the grade mix should not have to scroll past
// three tables to find it, and a reader who has just read a production callout
// should be able to get to the row it names.
//
// ── THREE RULES IT OBEYS ─────────────────────────────────────────────────────
//
// 1. **NO LAYOUT SHIFT.** It is a normal flow element that becomes `sticky` —
//    sticky never removes an element from flow, so nothing below it moves when
//    it pins. Its height is fixed by its own content and does not change with
//    the active item (the active state is a colour and a background, never a
//    weight change or an added glyph, both of which would reflow the row).
//
// 2. **GLASS, because it floats over scrolling content.** The canonical
//    frosted pattern, and legal here for the reason the design system gives:
//    this is a fixed/sticky bar over EMPTY page background, not a frozen table
//    pane over moving cells — those must be fully opaque and are, in all four
//    tables on this page.
//
// 3. **The active section is OBSERVED, not guessed.** An IntersectionObserver
//    over the real anchor elements, so the highlight follows the page whether
//    the reader clicked a link, scrolled by hand or landed on a deep link. No
//    scroll listener, no measurement on every frame.
//
// The anchors are the section elements themselves (`scroll-mt-24` clears this
// bar) — two of them are `<tr>` band rows INSIDE the matrix table, which is
// deliberate: "Overview" and "Money" are bands of one table, not blocks of
// their own, and pointing at the table twice would be a lie about its shape.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { cn } from "@/lib/utils";

export interface AnalyticsNavItem {
  /** The element id to scroll to. */
  id: string;
  label: string;
  /** What the reader gets there. */
  title: string;
}

export const ANALYTICS_NAV: readonly AnalyticsNavItem[] = [
  {
    id: "band-flow",
    label: "Overview",
    title: "Volume and stock — what moved through the yard and what was left standing in it.",
  },
  {
    id: "band-money",
    label: "Money",
    title:
      "What the charcoal we fed actually cost, on arrival and again after the weight it lost while it sat.",
  },
  {
    id: "section-campaigns",
    label: "Campaigns",
    title: "The production-batch basis — one column per campaign, including the cost of storage time.",
  },
  {
    id: "section-suppliers",
    label: "Suppliers",
    title: "Who we bought from, what share of the yard each one is, and on what terms.",
  },
  {
    id: "section-production",
    label: "Production",
    title: "What the plant made, how long it stood still, what it burned, and the grade mix.",
  },
  // OWNER FEEDBACK R1: the Watchlist anchor is gone with its section — Renzo
  // does not want a list of "piles to go look at" on this page. The aging
  // MATRIX rows (Avg stock age, Stock over 120 days) are untouched and still
  // live in the Money band above.
];

export function AnalyticsNav() {
  const [active, setActive] = React.useState<string | null>(null);

  // A deep link lands with the hash already set, so the highlight starts where
  // the reader does rather than waiting for the first scroll.
  React.useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id && ANALYTICS_NAV.some((i) => i.id === id)) setActive(id);
  }, []);

  React.useEffect(() => {
    const targets = ANALYTICS_NAV.map((i) => document.getElementById(i.id)).filter(
      (el): el is HTMLElement => el != null,
    );
    if (targets.length === 0) return;

    // The band that most recently crossed the top of the viewport wins. The
    // bottom margin keeps a section from claiming the highlight while it is
    // still only visible at the very bottom of a tall screen.
    const seen = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const current = ANALYTICS_NAV.filter((i) => seen.get(i.id));
        setActive(current[current.length - 1]?.id ?? null);
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: 0 },
    );
    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <nav
      aria-label="Sections of this page"
      className={cn(
        // z-40, not 30: the frozen-pane scale tops out at 30 (`.frozen-corner`),
        // and a sticky table corner and this bar share the root stacking
        // context — at equal z the later element in the DOM wins, which would
        // be the table.
        "sticky top-0 z-40 -mx-3 px-3 sm:-mx-6 sm:px-6",
        "border-b border-border/60",
        "bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60",
      )}
    >
      <ul className="flex items-center gap-0.5 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {ANALYTICS_NAV.map((item) => {
          const isActive = active === item.id;
          return (
            <li key={item.id} className="shrink-0">
              <a
                href={`#${item.id}`}
                title={item.title}
                // Claim the highlight on the click itself, so the bar answers
                // immediately rather than after the observer catches up mid-scroll.
                onClick={() => setActive(item.id)}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "block rounded px-2 py-0.5 text-[11px] transition-colors duration-150",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
