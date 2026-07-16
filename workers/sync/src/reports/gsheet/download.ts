/**
 * download.ts — the Google Sheet export fetch (sync_gsheet.py::ensure_workbook).
 *
 * The Sheet is pulled via a plain HTTPS GET of its XLSX export URL — NO auth,
 * link-shared "anyone with link" access assumed. `fetch` is INJECTED so tests can
 * stub it; runReport passes the platform fetch. The parity harness never calls this
 * (fixtures provide the workbook directly) — it's runReport-only.
 *
 * Validation mirrors the Python: the downloaded bytes must start with the ZIP magic
 * `PK` (every xlsx does). curl/fetch does NOT fail on an HTML error page — it just
 * returns whatever bytes came back — so this magic-number check is the ONLY signal
 * that the export actually succeeded (vs. a "restricted, please sign in" HTML page).
 */

export const GSHEET_FILE_ID = "1yBZ0wW0DTr4ktYYtDIgXSVVoGsiETawyppkdyV1EiMM";
export const GSHEET_EXPORT_URL = `https://docs.google.com/spreadsheets/d/${GSHEET_FILE_ID}/export?format=xlsx`;

/** Minimal fetch surface the downloader needs (Node/undici `fetch`). */
export type FetchLike = (
  url: string,
  init?: { redirect?: "follow" | "manual" | "error" },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Download the Sheet export as an xlsx Buffer. Follows redirects (Google issues a
 * 307 to the actual file host). Throws if the bytes are not a ZIP (xlsx) — the
 * Python's "Sheet not reachable as XLSX (got an HTML login page?)" guard.
 */
export async function downloadGsheet(
  fetchImpl: FetchLike,
  url: string = GSHEET_EXPORT_URL,
): Promise<Buffer> {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`gsheet export fetch failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    // 0x50 0x4b === "PK"
    throw new Error(
      "Sheet not reachable as XLSX (got an HTML login page?). " +
        "It may have gone restricted — re-share as 'anyone with link'.",
    );
  }
  return buf;
}
