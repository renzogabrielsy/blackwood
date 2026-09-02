// ─────────────────────────────────────────────────────────────────────────────
// PRINT ONE CARD — the mechanism, extracted (owner feedback R4).
//
// It lived inside `metric-expand.tsx` from owner feedback R1, when the metric
// expand was the only printable card on the page. R4's universal module
// contract makes every expand printable — Renzo: *"each module is something I
// look at and possibly report"* — so the supplier expand needs it too, and two
// copies of a mechanism this fiddly would drift the first time one of them was
// touched. Moved verbatim; no behaviour changed.
//
// `bw-printing` on <body> is what the print stylesheet keys off, and every
// ancestor from the card up to <body> is tagged `data-print-ancestor` so the
// sheet can `display: none` everything ELSE rather than merely hide it. That
// distinction is the whole mechanism — see the block comment on the print rules
// in `globals.css`: hiding by visibility leaves the page's full height behind
// and the card lands on page three of a mostly blank document.
//
// Both marks come off on `afterprint`, whether the user printed, saved a PDF or
// cancelled the dialog. The `setTimeout` fallback is there because not every
// engine fires `afterprint` on a dismissed dialog, and a body left in the
// printing class would print the wrong thing NEXT time.
//
// A plain module, not a `"use client"` one: it is imported only by client
// components, so it is bundled with them, and it touches the DOM at CALL time
// rather than at import time.
// ─────────────────────────────────────────────────────────────────────────────

// ── OWNER FEEDBACK R5 — IT MAY NOW MARK THE CARD ITSELF ─────────────────────
//
// R5 adds two print paths whose subject is not a permanently-marked expand
// panel: a whole metric GROUP (a stage of cards built for the occasion) and the
// campaign table (an ordinary section). Both need `data-print-card` for the
// duration of the print and MUST NOT carry it the rest of the time — the print
// stylesheet keys "hide everything else" off exactly that attribute, so a
// second element wearing it permanently would leave the campaign panel
// rendered on the sheet every time someone printed a metric.
//
// So the attribute is applied here when it is missing and removed again with
// the rest of the marks. An element that already carries it (the two expand
// panels, unchanged since R1/R4) is left exactly as it was.
export function printCard(card: HTMLElement | null) {
  if (typeof document === "undefined" || !card) return;
  const body = document.body;

  const ownedCardMark = !card.hasAttribute("data-print-card");
  if (ownedCardMark) card.setAttribute("data-print-card", "");

  const tagged: HTMLElement[] = [];
  for (
    let el: HTMLElement | null = card.parentElement;
    el && el !== document.documentElement;
    el = el.parentElement
  ) {
    el.setAttribute("data-print-ancestor", "");
    tagged.push(el);
  }

  const clear = () => {
    body.classList.remove("bw-printing");
    for (const el of tagged) el.removeAttribute("data-print-ancestor");
    if (ownedCardMark) card.removeAttribute("data-print-card");
  };

  body.classList.add("bw-printing");
  window.addEventListener("afterprint", clear, { once: true });
  window.setTimeout(clear, 1000);
  window.print();
}
