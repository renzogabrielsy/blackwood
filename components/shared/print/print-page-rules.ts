'use client';

// ═════════════════════════════════════════════════════════════════════════════════
// **PLATFORM MODULE (2026-09-17).** THE `@page` BLOCK, INJECTED FOR THE DURATION OF
// ONE PRINT AND REMOVED AFTERWARDS.
//
// `app/globals.css` already declares `@page { size: A4 landscape; margin: 12mm }`,
// and **`@page` CANNOT BE SCOPED TO A CLASS** — that one rule governs every print in
// the app. A dense report that needs a tighter margin (four more millimetres of
// height is roughly two more day rows) therefore cannot simply add a rule: it has to
// take one away from /analytics for the duration and give it back.
//
// So the block is created when a print starts and removed when the stage unmounts —
// which is on `afterprint`, since that is what unmounts the stage. It comes LATER in
// document order than `globals.css` at equal specificity, so it wins while it exists
// and leaves nothing behind when it does not.
//
// **`print-color-adjust: exact` IS LOAD-BEARING, NOT POLISH.** Without it a browser
// drops every background fill unless the person printing happens to tick "Background
// graphics" in the dialog — i.e. the colour is in the markup and absent from the
// paper, which is indistinguishable from never having built it. `globals.css` sets it
// on `[data-print-card] *` and a stage lives inside one; it is re-stated per report so
// a report's colour never depends on a rule written for a different report.
//
// ZERO tenant knowledge: it takes a margin, an attribute name and an optional string
// of extra CSS. It is `'use client'` only because the hook is.
// ═════════════════════════════════════════════════════════════════════════════════

import * as React from 'react';

export interface PrintPageRulesOptions {
  /**
   * The data-attribute the report puts on each of its printed pages, WITHOUT
   * brackets — e.g. `data-rcm-print`. Everything except the `@page` rule is scoped to
   * it, so one report's table rules cannot reach another report's tables.
   */
  scopeAttr: string;
  /** Must be the same number the report's page-box arithmetic used. */
  marginMm: number;
  /** Anything else this report needs, already scoped by the caller. */
  extraCss?: string;
}

/**
 * The rules, as a string.
 *
 * EXPORTED as a pure function so a report's sheet can be mounted STATICALLY in a
 * real print box and measured — a page-fitting promise verified by estimating the
 * page is not verified at all.
 *
 * **NO `tfoot` RULE, and that is deliberate.** Chrome REPEATS a `<tfoot>` on every
 * printed page, so a totals row in one prints once per sheet and reads as a
 * duplicated total. A printable report puts its totals in the LAST `<tbody>` rows;
 * `<thead>` keeps `table-header-group`, because a header that repeats is a help.
 */
export function buildPrintPageRules({
  scopeAttr,
  marginMm,
  extraCss = '',
}: PrintPageRulesOptions): string {
  const s = `[${scopeAttr}]`;
  return `
@page { size: A4 landscape; margin: ${marginMm}mm; }
${s}, ${s} * {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
${s} table { break-inside: auto; }
${s} thead { display: table-header-group; }
${s} tr { break-inside: avoid; break-after: auto; }
${extraCss}
`;
}

/**
 * Mount the rules while `css` is non-null; take them away again when it is not.
 *
 * The caller passes null when no print is in flight, which is what makes the removal
 * automatic: the stage unmounts on `afterprint`, the state flips, the effect cleans
 * up. Nothing is left behind for the NEXT print to inherit.
 */
export function usePrintPageRules(css: string | null, id = 'bw-print-page-rules'): void {
  React.useEffect(() => {
    if (!css || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
    return () => {
      el.remove();
    };
  }, [css, id]);
}
