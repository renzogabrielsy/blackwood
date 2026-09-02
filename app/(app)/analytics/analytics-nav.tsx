"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE IN-PAGE ANCHOR ROW — three destinations for a page that runs several
// screens. (Five until R4 dissolved the Money band; four until R7 merged the
// campaign panel and the production band into one table. See below.)
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
// bar) — the first is a `<tr>` band row INSIDE the matrix table, which is
// deliberate: "RC Inventory" is a band of that table, not a block of its own.
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
    // OWNER FEEDBACK R4: "Overview" named a position on the page rather than a
    // subject. The band it points at now answers one question end to end —
    // what came in, what went out, what is standing in the yard, what it cost
    // per kilo and how old it is — so the anchor says that.
    id: "band-flow",
    label: "RC Inventory",
    title:
      "What moved through the yard, what is left standing in it, what that stock cost per kilo and how old it is.",
  },
  // OWNER FEEDBACK R4: the **Money** anchor is gone with its band. Renzo:
  // "money is redundant, most of it is analyzable in the by-production-batch
  // section." The campaign panel below is where the cost questions now live —
  // on the clock the plant actually runs on rather than the calendar's.
  // OWNER FEEDBACK R7: **there is no separate Production anchor any more.** The
  // campaign panel and the production band were merged into ONE table — same
  // axis, same columns, same checklist, and Produced and Yield printed twice —
  // so a second anchor would name a section that no longer exists. The one
  // below covers both, and the grade mix that sits under them.
  {
    id: "section-campaigns",
    label: "Campaigns",
    title:
      "One column per production batch: what it fed, what that charcoal cost, what the plant made from it, what it burned doing so, and the grade mix.",
  },
  {
    id: "section-suppliers",
    label: "Suppliers",
    title: "Who we bought from, what share of the yard each one is, and on what terms.",
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
                  "block rounded px-2 py-0.5 text-[length:var(--bw-fs-11)] transition-colors duration-150",
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
