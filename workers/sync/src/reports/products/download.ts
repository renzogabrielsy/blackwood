/**
 * download.ts — the PRODUCTS INVENTORY Google Sheet export fetch.
 *
 * Deliberately the same shape as `reports/gsheet/download.ts`: a plain HTTPS GET of the
 * XLSX export URL, no auth, link-shared "anyone with link" access assumed, and the ZIP
 * magic-number check as the ONLY signal that the export actually succeeded — `fetch`
 * does not fail on an HTML "restricted, please sign in" page, it just hands back its
 * bytes, and a sync that parsed a login page as a workbook would report zero grades on a
 * file full of them.
 *
 * The file id is a module constant with a `PRODUCTS_SHEET_ID` environment OVERRIDE, so
 * the default is version-controlled and reviewable (as gsheet's is) while a different
 * sheet can be pointed at without a deploy of new code. See workers/sync/DEPLOY.md for
 * the Fly secret.
 */

export const PRODUCTS_SHEET_ID_DEFAULT = "1s2YqAuBbZBZRfw5XH_ZhbA9dYDO0raxDDuFbcHfmEog";

/** The sheet id in force: `PRODUCTS_SHEET_ID` when set and non-blank, else the default. */
export function productsSheetId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PRODUCTS_SHEET_ID ?? "").trim();
  return raw || PRODUCTS_SHEET_ID_DEFAULT;
}

export function productsExportUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `https://docs.google.com/spreadsheets/d/${productsSheetId(env)}/export?format=xlsx`;
}

/** Minimal fetch surface (Node/undici `fetch`). Injected so tests can stub it. */
export type FetchLike = (
  url: string,
  init?: { redirect?: "follow" | "manual" | "error" },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export async function downloadProductsSheet(
  fetchImpl: FetchLike,
  url: string = productsExportUrl(),
): Promise<Buffer> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`products sheet export fetch failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(
      "PRODUCTS INVENTORY sheet not reachable as XLSX (got an HTML login page?). " +
        "It may have gone restricted — re-share as 'anyone with link'.",
    );
  }
  return buf;
}
