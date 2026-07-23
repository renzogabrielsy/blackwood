// Shipments module — LIST page (Server Component). Lists every export-shipment
// card on the Trello board with its per-customer readiness, checklist progress,
// and attachment count. Read-only against Trello (lib/shipments/trello.ts).
//
// TENANT/domain code (ICTC charcoal export shipments). Navbar owns the page title
// (registered in getBreadcrumb) — the page renders content only. No ₱ in this
// domain → zero price-gating.

import Link from "next/link";
import { format, parseISO } from "date-fns";
import { Paperclip, ArrowRight, Package } from "lucide-react";
import { listShipments } from "@/lib/shipments/trello";
import type { ShipmentSummary } from "@/lib/shipments/types";
import { ReadinessChip, ChecklistBar } from "./readiness-chip";
import { ShipmentsError } from "./shipments-error";

// Trello is a live external source — never statically cache this route.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ShipmentsPage() {
  let shipments: ShipmentSummary[] = [];
  let error: string | null = null;
  try {
    shipments = await listShipments();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const complete = shipments.filter((s) => s.readiness.complete).length;
  const incomplete = shipments.length - complete;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        {/* Summary strip */}
        <div className="flex flex-wrap items-center gap-2 animate-fade-up">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Package className="h-3.5 w-3.5" />
            Export shipments
          </span>
          {!error && (
            <>
              <span className="text-xs text-muted-foreground">
                {shipments.length} on board · {complete} complete · {incomplete} in progress
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                Readiness = customer send-out docs present on Trello
              </span>
            </>
          )}
        </div>

        {error && <ShipmentsError message={error} />}

        {!error && shipments.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No shipment cards found on the board.
          </div>
        )}

        {!error && shipments.length > 0 && (
          <ul className="flex flex-col gap-2.5">
            {shipments.map((s) => (
              <li key={s.cardId}>
                <ShipmentCard shipment={s} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ShipmentCard({ shipment: s }: { shipment: ShipmentSummary }) {
  return (
    <Link
      href={`/shipments/${s.cardId}`}
      className="hover-lift group block rounded-lg border border-border bg-card/95 p-3.5 backdrop-blur transition-colors hover:border-primary/40 sm:p-4"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {/* Title + customer */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {s.prefix && (
              <span className="font-mono text-sm font-semibold tabular-nums text-primary">{s.prefix}</span>
            )}
            <h2 className="truncate text-sm font-semibold" title={s.title}>
              {s.title}
            </h2>
          </div>
          {s.readiness.hasRequirementSet && !s.readiness.complete && (
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium text-amber-700 dark:text-amber-500">Missing:</span>{" "}
              {s.readiness.missing.join(", ")}
            </p>
          )}
          {s.readiness.hasRequirementSet && s.readiness.complete && (
            <p className="mt-1 text-xs text-muted-foreground">All customer send-out docs present.</p>
          )}
        </div>

        {/* Right meta cluster */}
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ReadinessChip readiness={s.readiness} />
          <div className="flex items-center gap-3">
            <ChecklistBar done={s.checklist.done} total={s.checklist.total} />
            <span className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-muted-foreground">
              <Paperclip className="h-3 w-3" />
              {s.attachmentCount}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
          </div>
        </div>
      </div>

      {s.lastActivity && (
        <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          Updated {safeDate(s.lastActivity)}
        </p>
      )}
    </Link>
  );
}

function safeDate(iso: string): string {
  try {
    return format(parseISO(iso), "yyyy-MM-dd HH:mm");
  } catch {
    return iso;
  }
}
