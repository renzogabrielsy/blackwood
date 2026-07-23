// GET /shipments/[cardId]/download/[attachmentId] — stream a SINGLE Trello
// attachment, renamed to its canonical house name. The per-file counterpart to the
// ZIP route (../route.ts); both paths coexist. Read-only against Trello.
//
// Attachment downloads REQUIRE the OAuth Authorization header (Trello dropped
// key/token query-param auth for file downloads in 2021) — see attachmentAuthHeader().
// The token stays server-side and is never exposed to the client.

import { attachmentAuthHeader, getAttachmentForDownload } from "@/lib/shipments/trello";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ILLEGAL = /[<>:"/\\|?*]/g;

/** Sanitize a string for a file name: drop only truly illegal chars, KEEP spaces +
 *  hyphens (readability), collapse runs of whitespace. */
function sanitize(name: string): string {
  return name.replace(ILLEGAL, "").replace(/\s+/g, " ").trim();
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ cardId: string; attachmentId: string }> }
) {
  const { cardId, attachmentId } = await ctx.params;

  let found: Awaited<ReturnType<typeof getAttachmentForDownload>>;
  try {
    found = await getAttachmentForDownload(cardId, attachmentId);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e), 502);
  }
  // 404 if the card or attachment id isn't on that card.
  if (!found) return errorResponse("Attachment not found on this shipment card.", 404);

  const { attachment, canonicalName } = found;
  if (attachment.bytes == null) {
    return errorResponse("This attachment is a link, not a downloadable file.", 404);
  }

  const res = await fetch(attachment.url, { headers: attachmentAuthHeader(), cache: "no-store" }).catch(() => null);
  if (!res || !res.ok) {
    return errorResponse(
      `Failed to download "${attachment.name}" (${res ? `${res.status} ${res.statusText}` : "network error"}).`,
      502
    );
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  const fileName = sanitize(canonicalName);
  const asciiName = fileName.replace(/[^ -~]/g, "_");
  const contentType = attachment.mimeType || "application/octet-stream";

  return new Response(new Blob([buf as BlobPart], { type: contentType }), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buf.byteLength),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
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
