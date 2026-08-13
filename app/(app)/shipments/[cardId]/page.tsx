// Shipments module — DETAIL page (Server Component). One shipment card: the
// per-customer present/missing doc breakdown, the full attachment list under
// CANONICAL names (via the ported renamer), checklist state, and a prominent
// "Download all as ZIP" button (the /download route). Read-only against Trello.

import Link from "next/link";
import { format, parseISO } from "date-fns";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  CheckCircle2,
  CircleAlert,
  ListChecks,
  FileText,
} from "lucide-react";
import { planSendOutSet } from "@/lib/shipments/requirements";
import { getShipment } from "@/lib/shipments/trello";
import type { ClassifiedAttachment, ShipmentDetail } from "@/lib/shipments/types";
import { cn } from "@/lib/utils";
import { ReadinessChip } from "../readiness-chip";
import { ShipmentsError } from "../shipments-error";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ cardId: string }>;
}) {
  const { cardId } = await params;

  let detail: ShipmentDetail | null = null;
  let error: string | null = null;
  try {
    detail = await getShipment(cardId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        <Link
          href="/shipments"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All shipments
        </Link>

        {error && <ShipmentsError message={error} />}

        {!error && !detail && (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Shipment card not found on the board.
          </div>
        )}

        {detail && <ShipmentDetailBody detail={detail} />}
      </div>
    </div>
  );
}

function ShipmentDetailBody({ detail }: { detail: ShipmentDetail }) {
  const { readiness } = detail;

  // The send-out set, planned server-side from the SAME predicate the chips below
  // render from — so the button's count and the ZIP's contents cannot disagree.
  const plan = planSendOutSet<ClassifiedAttachment>(
    detail.title,
    detail.attachments,
    (a) => a.originalName,
    (a) => a.bytes != null
  );
  const inSetIds = new Set(plan.selected.map((s) => s.item.id));

  return (
    <>
      {/* Header — title + download */}
      <div className="flex flex-wrap items-start justify-between gap-3 animate-fade-up">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {detail.prefix && (
              <span className="font-mono text-lg font-semibold tabular-nums text-primary">{detail.prefix}</span>
            )}
            <h1 className="text-lg font-semibold">{detail.title}</h1>
            <ReadinessChip readiness={readiness} />
          </div>
          {detail.lastActivity && (
            <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground/70">
              Updated {safeDate(detail.lastActivity)} · {detail.attachments.length} attachments
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {detail.shortUrl && (
            <a
              href={detail.shortUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open in Trello
            </a>
          )}
          {/* Plain GET link to the zip route — download is user-initiated. */}
          <a
            href={`/shipments/${detail.cardId}/download`}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          >
            <Download className="h-4 w-4" />
            Download all as ZIP
          </a>
        </div>
      </div>

      {/* Customer send-out set — present / missing */}
      {readiness.hasRequirementSet ? (
        <section className="rounded-lg border border-border bg-card/95 p-4 backdrop-blur">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {readiness.customer} send-out set
              </h2>
              <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
                {readiness.required.length - readiness.missing.length}/{readiness.required.length} present
              </span>
            </div>

            {/* The set download — the common action, so it sits on the card he was
                looking at, at the same weight as the header's "Download all as ZIP". */}
            {plan.selected.length > 0 ? (
              <a
                href={`/shipments/${detail.cardId}/download?set=sendout`}
                title={
                  plan.complete
                    ? `Download the ${plan.totalCount} ${readiness.customer} send-out documents as a ZIP`
                    : `Download the ${plan.presentCount} of ${plan.totalCount} send-out documents present — missing: ${plan.absent.join(", ")}`
                }
                className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
              >
                <Download className="h-4 w-4" />
                Download send-out set
                <span className="font-mono tabular-nums opacity-80">
                  {plan.complete ? `· ${plan.totalCount} docs` : `· ${plan.presentCount} of ${plan.totalCount}`}
                </span>
              </a>
            ) : (
              <span
                aria-disabled="true"
                title={`None of the ${plan.totalCount} required documents are attached as files yet.`}
                className="inline-flex h-9 cursor-not-allowed items-center gap-1.5 rounded-md border border-dashed border-border px-3.5 text-xs font-medium text-muted-foreground/60"
              >
                <Download className="h-4 w-4" />
                Nothing in the set yet
              </span>
            )}
          </div>

          {!plan.complete && plan.selected.length > 0 && (
            <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-300">
              The set download is a <span className="font-semibold">partial {plan.presentCount} of {plan.totalCount}</span> —
              its filename says so and it carries a note listing what is missing.
            </p>
          )}
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {readiness.required.map((doc) => {
              const present = !readiness.missing.includes(doc);
              return (
                <li
                  key={doc}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
                    present
                      ? "border-emerald-500/25 bg-emerald-500/5"
                      : "border-amber-500/30 bg-amber-500/10"
                  )}
                >
                  {present ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <CircleAlert className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  )}
                  <span className={cn(present ? "text-foreground" : "font-medium text-amber-800 dark:text-amber-300")}>
                    {doc}
                  </span>
                  {!present && <span className="ml-auto text-[10px] uppercase text-amber-600">missing</span>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <section className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          Customer{readiness.customer ? ` "${readiness.customer}"` : ""} has no configured send-out doc set —
          readiness cannot be scored. Attachments are still listed below.
          {/* No set means no way to know which docs the customer gets, so the set
              download is stated as unavailable rather than offered as an empty ZIP. */}
          <span className="mt-1 block text-muted-foreground/70">
            The send-out set download is unavailable for this shipment. Use{" "}
            <span className="font-medium">Download all as ZIP</span> above and pick the files by hand.
          </span>
        </section>
      )}

      {/* Attachments under canonical names */}
      <section className="rounded-lg border border-border bg-card/95 backdrop-blur">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Attachments · canonical names
          </h2>
        </div>
        {detail.attachments.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">No attachments on this card.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] table-fixed border-collapse text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-[42%] px-3 py-1.5 font-medium">Canonical name</th>
                  <th className="w-[22%] px-3 py-1.5 font-medium">Doc type</th>
                  <th className="w-[20%] px-3 py-1.5 font-medium">Original</th>
                  <th className="w-[8%] px-3 py-1.5 text-right font-medium">Size</th>
                  <th className="w-[44px] px-2 py-1.5 text-center font-medium">
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.attachments.map((a) => (
                  <tr key={a.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-1.5">
                      <span className="block truncate font-medium" title={a.canonicalName}>
                        {a.canonicalName}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-1.5">
                        {a.docType ? (
                          <span className="truncate text-muted-foreground">{a.docType}</span>
                        ) : (
                          <span className="truncate text-muted-foreground/50">{a.kind}</span>
                        )}
                        {/* Which rows the set download will actually take. */}
                        {inSetIds.has(a.id) && (
                          <span
                            title={`Included in the ${readiness.customer} send-out set`}
                            className="shrink-0 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400"
                          >
                            set
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="block truncate text-muted-foreground/70" title={a.originalName}>
                        {a.originalName}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                      {fmtKb(a.bytes)}
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      {a.bytes != null ? (
                        <a
                          href={`/shipments/${detail.cardId}/download/${a.id}`}
                          download={a.canonicalName}
                          title={`Download ${a.canonicalName}`}
                          aria-label={`Download ${a.canonicalName}`}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      ) : (
                        <span className="text-muted-foreground/30">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Checklists */}
      {detail.checklists.length > 0 && (
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {detail.checklists.map((ch) => (
            <div key={ch.id} className="rounded-lg border border-border bg-card/95 p-3.5 backdrop-blur">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                  <h3 className="text-xs font-semibold">{ch.name}</h3>
                </div>
                <span
                  className={cn(
                    "text-[11px] font-mono tabular-nums",
                    ch.done === ch.total && ch.total > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground"
                  )}
                >
                  {ch.done}/{ch.total}
                </span>
              </div>
              <ul className="flex flex-col gap-1">
                {ch.items.map((item, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-[11px]">
                    <span
                      className={cn(
                        "mt-[3px] h-2.5 w-2.5 shrink-0 rounded-[3px] border",
                        item.complete ? "border-emerald-500 bg-emerald-500" : "border-muted-foreground/40"
                      )}
                    />
                    <span className={cn(item.complete ? "text-muted-foreground line-through" : "text-foreground")}>
                      {item.name}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function fmtKb(bytes: number | null): string {
  if (bytes == null) return "—";
  const kb = bytes / 1024;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)}M`;
  return `${Math.round(kb)}K`;
}

function safeDate(iso: string): string {
  try {
    return format(parseISO(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return iso;
  }
}
