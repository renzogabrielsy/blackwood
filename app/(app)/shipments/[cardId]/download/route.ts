// GET /shipments/[cardId]/download — stream a shipment card's Trello attachments,
// renamed to their canonical house names, compiled into a single ZIP (Google-Drive
// "download all" style). Read-only against Trello.
//
// TWO SETS, ONE ROUTE. `?set=sendout` narrows the ZIP to the CUSTOMER SEND-OUT set
// (the docs that go to the buyer) instead of every attachment on the card. The
// filter is a search param rather than a second route on purpose: the OAuth header,
// canonical renaming, sanitising, collision dedup and zipping are subtle and must
// have exactly one implementation. Two ZIP builders would drift.
//
// Attachment downloads REQUIRE the OAuth Authorization header (Trello dropped
// key/token query-param auth for file downloads in 2021) — see attachmentAuthHeader().
// In-memory zipping is fine here: a shipment is ~16 files / ~20MB, well within
// serverless response limits. The local Shipments folder remains the archive of
// record; this ZIP is a convenience surface.

import { zip } from "fflate";
import { classify } from "@/lib/shipments/classify";
import { planSendOutSet, sendOutZipBaseName } from "@/lib/shipments/requirements";
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

export async function GET(req: Request, ctx: { params: Promise<{ cardId: string }> }) {
  const { cardId } = await ctx.params;

  // Which set? Absent = every attachment (the original behaviour). An unrecognized
  // value is REFUSED rather than silently falling back to "everything" — a typo'd
  // param must never hand over 14 files when 7 were asked for.
  const setParam = new URL(req.url).searchParams.get("set");
  if (setParam !== null && setParam !== "sendout") {
    return errorResponse(`Unknown set "${setParam}". The only supported value is "sendout".`, 400);
  }
  const sendOutOnly = setParam === "sendout";

  let card: Awaited<ReturnType<typeof getCardForDownload>>;
  try {
    card = await getCardForDownload(cardId);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : String(e), 502);
  }
  if (!card) return errorResponse("Shipment card not found on the board.", 404);

  // Only uploaded files (bytes present) are downloadable; link-type attachments are skipped.
  const allFiles = card.attachments.filter((a) => a.bytes != null);

  // Plan the customer send-out set over EVERY attachment (so `absent` also catches a
  // required doc that exists only as a Trello link and therefore cannot be shipped).
  const plan = planSendOutSet(
    card.title,
    card.attachments,
    (a) => a.name,
    (a) => a.bytes != null
  );

  let downloadable: TrelloAttachment[];
  if (sendOutOnly) {
    if (!plan.readiness.hasRequirementSet) {
      return errorResponse(
        `No send-out doc set is configured for this shipment${
          plan.readiness.customer ? ` (customer "${plan.readiness.customer}")` : " (customer could not be resolved from the card title)"
        }, so the set cannot be assembled. Use "Download all as ZIP" instead.`,
        409
      );
    }
    downloadable = plan.selected.map((s) => s.item);
    if (downloadable.length === 0) {
      return errorResponse(
        `None of the ${plan.totalCount} ${plan.readiness.customer} send-out documents are attached as files yet ` +
          `(missing: ${plan.absent.join(", ")}).`,
        404
      );
    }
  } else {
    downloadable = allFiles;
    if (downloadable.length === 0) {
      return errorResponse("This shipment has no downloadable file attachments.", 404);
    }
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

  // A PARTIAL set must never look complete once it's out of the browser. Two signals:
  // the filename below, and this manifest INSIDE the archive — the filename can be
  // renamed or lost when the ZIP is forwarded; a file in the archive travels with it.
  // Nothing is added when the set is complete.
  if (sendOutOnly && !plan.complete) {
    // ASCII-only entry name: a ZIP entry needs the UTF-8 general-purpose flag to
    // survive some Windows unzip tools, and this name has no reason to risk it.
    let manifestName = "_INCOMPLETE - MISSING DOCUMENTS.txt";
    for (let n = 2; manifestName in files; n += 1) {
      manifestName = `_INCOMPLETE - MISSING DOCUMENTS (${n}).txt`;
    }
    files[manifestName] = new TextEncoder().encode(buildManifest(card.title, plan));
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

  const zipName =
    sanitize(
      sendOutOnly
        ? sendOutZipBaseName(
            card.title,
            card.prefix,
            plan.readiness.customer ?? "CUSTOMER",
            plan.presentCount,
            plan.totalCount
          )
        : card.title
    ) + ".zip";
  const asciiName = zipName.replace(/[^ -~]/g, "_");

  const setHeaders: Record<string, string> = sendOutOnly
    ? {
        "X-Sendout-Set": plan.readiness.customer ?? "unknown",
        "X-Sendout-Present": String(plan.presentCount),
        "X-Sendout-Total": String(plan.totalCount),
        "X-Sendout-Complete": String(plan.complete),
        // Named so a partial set is machine-detectable, not just visible in the name.
        ...(plan.absent.length > 0 ? { "X-Sendout-Missing": plan.absent.join(", ") } : {}),
      }
    : {};

  // Wrap in a Blob so the body is an unambiguous BodyInit (a bare
  // Uint8Array<ArrayBufferLike> isn't accepted by the Response type).
  return new Response(new Blob([zipped as BlobPart], { type: "application/zip" }), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zipped.byteLength),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      "Cache-Control": "no-store",
      ...setHeaders,
    },
  });
}

/** Plain-text note shipped inside an INCOMPLETE send-out ZIP. Says what is in the
 *  archive and, crucially, what is not — including a required doc that exists on the
 *  card only as a link and so could not be included. */
function buildManifest(cardTitle: string, plan: ReturnType<typeof planSendOutSet<TrelloAttachment>>): string {
  const lines: string[] = [
    `INCOMPLETE SEND-OUT SET — DO NOT SEND AS-IS`,
    ``,
    `Shipment : ${cardTitle}`,
    `Customer : ${plan.readiness.customer ?? "unresolved"}`,
    `Contains : ${plan.presentCount} of ${plan.totalCount} required documents`,
    `Generated: ${new Date().toISOString()}`,
    ``,
    `MISSING (${plan.absent.length}):`,
    ...plan.absent.map((d) => `  - ${d}`),
    ``,
    `INCLUDED (${plan.selected.length} file${plan.selected.length === 1 ? "" : "s"}):`,
    ...plan.selected.map((s) => `  - ${s.docType} — ${s.item.name}`),
  ];

  const linkOnly = plan.excluded.filter((e) => e.reason === "not-a-file");
  if (linkOnly.length > 0) {
    lines.push(
      ``,
      `REQUIRED BUT NOT DOWNLOADABLE (attached to the Trello card as a LINK, not a file):`,
      ...linkOnly.map((e) => `  - ${e.docType} — ${e.item.name}`)
    );
  }

  lines.push(``, `Delete this file once the set is complete.`, ``);
  return lines.join("\r\n");
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
