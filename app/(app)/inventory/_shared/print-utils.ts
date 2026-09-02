/**
 * Shared native-print plumbing for the Blocking views (detail panel + blend proposal).
 *
 * The approach is deliberately NOT `@media print` DOM-toggling: that leaks the app's
 * dark mode, Tailwind, portals, overlays, transforms, and any fixed positioning into the
 * printout (it prints like a screenshot). Instead each view builds a fully self-contained
 * HTML document (its own `<html>` + minimal black-on-white print CSS) from the data it
 * already holds, and prints THAT in a hidden same-origin iframe — completely isolated
 * from the live app.
 *
 * Only the document-body builder differs per view; the escaping, peso formatting, and
 * iframe print mechanism are identical and live here.
 */

export const PESO = '₱';
export const EMDASH = '—';

/**
 * Identity of a SAVED blend proposal, for the printed / exported document.
 *
 * A live what-if has no identity — it is a question, asked once. A saved version has a
 * title, a remark, a version number and the moment the DATABASE computed its numbers,
 * and a printout that omits them cannot be told apart from a printout of a different
 * version of the same blend. `computedAt` is deliberately the SNAPSHOT's timestamp, not
 * `new Date()`: the document says when the yard looked like this, not when someone hit
 * Print.
 *
 * Every field is optional and an absent meta renders exactly the pre-existing document,
 * so the live modal's output is unchanged.
 */
export interface BlendDocMeta {
  title?: string | null;
  /** The proposal-level REMARK. */
  notes?: string | null;
  versionNo?: number | null;
  /** ISO timestamp from the snapshot — when the numbers were true. */
  computedAt?: string | null;
}

/** `v3 · as proposed 2026-09-02` — the saved-version line, or '' when not saved. */
export function blendVersionLine(meta?: BlendDocMeta | null): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.versionNo != null) parts.push(`v${meta.versionNo}`);
  const asOf = blendComputedDate(meta.computedAt);
  if (asOf) parts.push(`as proposed ${asOf}`);
  return parts.join(' · ');
}

/** `yyyy-MM-dd` from an ISO timestamp, or '' when absent/unparseable. */
export function blendComputedDate(computedAt?: string | null): string {
  if (!computedAt) return '';
  const d = new Date(computedAt);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Escape text destined for a print HTML string. Batch codes, block locs, supplier names,
 * destinations and free-text notes are user-provided and MUST be escaped before
 * interpolation so a stray `<`, `&`, or `"` can't break the generated markup.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Peso-formatted amount for the print doc (already safe — only digits/symbols). */
export function peso(n: number, fractionDigits = 2): string {
  return `${PESO}${n.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/**
 * Render a print document into a hidden same-origin iframe and invoke its print dialog.
 * Returns false (and the caller surfaces an error) if the iframe / its document can't be
 * created. The hidden-iframe path avoids popup-blockers entirely (no new window), and the
 * iframe is removed after printing — or after a fallback timeout if the browser doesn't
 * fire `afterprint` (some do not when the dialog is cancelled).
 */
export function printViaIframe(html: string): boolean {
  if (typeof document === 'undefined') return false;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';

  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  const doc = iframe.contentDocument ?? win?.document;
  if (!win || !doc) {
    iframe.remove();
    return false;
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Defer removal so the print job isn't torn out from under the engine.
    setTimeout(() => iframe.remove(), 0);
  };

  doc.open();
  doc.write(html);
  doc.close();

  const triggerPrint = () => {
    try {
      win.focus();
      win.addEventListener('afterprint', cleanup, { once: true });
      win.print();
      // Fallback: some browsers never fire afterprint (e.g. dialog cancelled).
      setTimeout(cleanup, 60_000);
    } catch {
      cleanup();
      throw new Error('print-failed');
    }
  };

  // Wait a tick for the iframe document to lay out before printing.
  if (doc.readyState === 'complete') {
    triggerPrint();
  } else {
    win.addEventListener('load', triggerPrint, { once: true });
    // Safety: if load never fires, print anyway shortly after write.
    setTimeout(() => {
      if (!cleaned) triggerPrint();
    }, 250);
  }

  return true;
}

/**
 * Shared minimal black-on-white print CSS used by every Blocking printout. Lives here so
 * the detail-panel and blend-proposal documents look identical. Returned as the inner
 * text of a `<style>` element.
 */
export const PRINT_CSS = `
  @page { margin: 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: #fff;
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 12px;
    line-height: 1.4;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1 { font-size: 18px; font-weight: 700; margin: 0 0 2px; }
  .subtitle { font-size: 11px; color: #444; margin: 0 0 16px; }
  section { break-inside: avoid; margin: 0 0 4px; }
  h2 {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    border-bottom: 1px solid #000; padding-bottom: 3px; margin: 18px 0 8px;
  }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 32px; margin: 0; }
  .row { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid #ddd; padding: 3px 0; }
  .row dt { font-weight: 600; color: #333; }
  .row dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
  .notes { margin: 0; white-space: pre-wrap; }
  .formula { margin: 8px 0 0; font-size: 11px; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; margin: 0; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; font-variant-numeric: tabular-nums; }
  th { font-weight: 700; background: #eee; text-transform: uppercase; font-size: 9px; letter-spacing: 0.03em; }
  td.num, th.num { text-align: right; }
  tfoot td { font-weight: 700; border-top: 2px solid #000; }
  .empty { margin: 0; color: #666; }
  .doc-footer { margin-top: 20px; padding-top: 8px; border-top: 1px solid #999; font-size: 9px; color: #666; }
`;
