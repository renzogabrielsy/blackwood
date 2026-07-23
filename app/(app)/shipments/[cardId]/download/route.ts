// GET /shipments/[cardId]/download — stream a shipment card's Trello attachments,
// renamed to their canonical house names, compiled into a single ZIP (Google-Drive
// "download all" style). Read-only against Trello.
//
// Attachment downloads REQUIRE the OAuth Authorization header (Trello dropped
// key/token query-param auth for file downloads in 2021) — see attachmentAuthHeader().
// In-memory zipping is fine here: a shipment is ~16 files / ~20MB, well within
// serverless response limits. The local Shipments folder remains the archive of
// record; this ZIP is a convenience surface.

import { zip } from "fflate";
import { classify } from "@/lib/shipments/classify";
import { attachmentAuthHeader, getCardForDownload } from "@/lib/shipments/trello";
import type { TrelloAttachment } from "@/lib/shipments/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ILLEGAL = /[<>:"/\\|?*]/g;

/** Sanitize a string for a file/zip name: drop only truly illegal chars, KEEP
 *  spaces + hyphens (readability), collapse runs of whitespace. */
function sanitize(name: string): string {
  return name.replace(ILLEGAL, "").replace(/\s+/g, " ").trim();
}

/** Split "NAME.pdf" -> ["NAME", ".pdf"] for dedup-suffix insertion. */
function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  return [name.slice(0, dot), name.slice(dot)];
}

export async function GET(_req: Request, ctx: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await ctx.params;

  let card: Awaited<ReturnType<typeof getCardForDownload>>;
  try {
    card = await getCardForDownload(cardId);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e), 502);
  }
  if (!card) return errorResponse("Shipment card not found on the board.", 404);

  // Only uploaded files (bytes present) are downloadable; link-type attachments are skipped.
  const downloadable = card.attachments.filter((a) => a.bytes != null);
  if (downloadable.length === 0) {
    return errorResponse("This shipment has no downloadable file attachments.", 404);
  }

  const authHeader = attachmentAuthHeader();

  // Fetch every attachment in parallel with the OAuth header, renaming to canonical.
  let fetchError: string | null = null;
  const entries = await Promise.all(
    downloadable.map(async (a: TrelloAttachment): Promise<{ canonical: string; buf: Uint8Array } | null> => {
      const res = await fetch(a.url, { headers: authHeader, cache: "no-store" }).catch(() => null);
      if (!res || !res.ok) {
        fetchError = `Failed to download "${a.name}" (${res ? `${res.status} ${res.statusText}` : "network error"}).`;
        return null;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const { canonical } = classify(a.name, card!.prefix);
      return { canonical: sanitize(canonical), buf };
    })
  );

  if (fetchError) return errorResponse(fetchError, 502);

  // Assemble the zip payload, de-duplicating collision-prone canonical names.
  const files: Record<string, Uint8Array> = {};
  const usedNames = new Map<string, number>();
  for (const entry of entries) {
    if (!entry) continue;
    const seen = usedNames.get(entry.canonical) ?? 0;
    usedNames.set(entry.canonical, seen + 1);
    let name = entry.canonical;
    if (seen > 0) {
      const [stem, ext] = splitExt(entry.canonical);
      name = `${stem} (${seen + 1})${ext}`;
    }
    files[name] = entry.buf;
  }

  let zipped: Uint8Array;
  try {
    zipped = await new Promise<Uint8Array>((resolve, reject) => {
      // level 0 (store): PDFs are already compressed, so storing is fast and small.
      zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)));
    });
  } catch (e) {
    return errorResponse(`Failed to build ZIP: ${e instanceof Error ? e.message : String(e)}`, 500);
  }

  const zipName = sanitize(card.title) + ".zip";
  const asciiName = zipName.replace(/[^ -~]/g, "_");

  // Wrap in a Blob so the body is an unambiguous BodyInit (a bare
  // Uint8Array<ArrayBufferLike> isn't accepted by the Response type).
  return new Response(new Blob([zipped as BlobPart], { type: "application/zip" }), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zipped.byteLength),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      "Cache-Control": "no-store",
    },
  });
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
