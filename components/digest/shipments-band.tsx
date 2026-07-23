// Home-digest SHIPMENTS band. An async Server Component that fetches Trello
// INDEPENDENTLY of getDigestData() (which is Supabase-only and perf-critical).
// It is wrapped in <Suspense> by app/(app)/page.tsx so it STREAMS in on its own —
// if Trello is slow or down, the rest of the digest renders instantly and this
// band arrives late (or shows a quiet unavailable note), never blocking paint.
//
// TENANT/domain code (ICTC export shipments). No ₱ in this domain → nothing gated.

import Link from "next/link";
import { Package, ArrowRight } from "lucide-react";
import { listShipments } from "@/lib/shipments/trello";
import { ReadinessChip } from "@/app/(app)/shipments/readiness-chip";
import type { ShipmentSummary } from "@/lib/shipments/types";

const CARD_CLS = "rounded-xl border border-border bg-card/95 p-4 backdrop-blur hover-lift";

/** Lightweight skeleton shown while the band streams in (Suspense fallback). */
export function ShipmentsBandFallback() {
  return (
    <div className={CARD_CLS}>
      <div className="mb-3 flex items-center gap-2">
        <Package className="h-4 w-4 text-muted-foreground" />
        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-6 w-40 animate-pulse rounded-md bg-muted/60" />
        ))}
      </div>
    </div>
  );
}

export async function ShipmentsBand() {
  let shipments: ShipmentSummary[];
  try {
    shipments = await listShipments();
  } catch {
    // Trello unavailable/unconfigured — degrade quietly, never break the digest.
    return (
      <div className={CARD_CLS}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Export shipments
            </h2>
          </div>
          <Link href="/shipments" className="text-[11px] font-medium text-primary hover:underline">
            Open →
          </Link>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Shipment readiness is temporarily unavailable.</p>
      </div>
    );
  }

  if (shipments.length === 0) return null;

  const complete = shipments.filter((s) => s.readiness.complete).length;
  const incomplete = shipments.filter((s) => !s.readiness.complete);

  return (
    <div className={`${CARD_CLS} animate-fade-up`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Export shipments
          </h2>
          <span className="text-[11px] text-muted-foreground">
            {complete} complete · {incomplete.length} in progress
          </span>
        </div>
        <Link
          href="/shipments"
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
        >
          View all
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {/* Surface the shipments still needing docs first (most actionable); fall back
          to a compact all-complete note when nothing is outstanding. */}
      {incomplete.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {incomplete.slice(0, 5).map((s) => (
            <li key={s.cardId}>
              <Link
                href={`/shipments/${s.cardId}`}
                className="group flex items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted/50"
              >
                {s.prefix && (
                  <span className="font-mono text-[11px] font-semibold tabular-nums text-primary">{s.prefix}</span>
                )}
                <span className="shrink-0 font-medium">{s.readiness.customer ?? "Unknown"}</span>
                <ReadinessChip readiness={s.readiness} />
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={s.readiness.missing.join(", ")}>
                  {s.readiness.hasRequirementSet ? `missing ${s.readiness.missing.join(", ")}` : "no doc set"}
                </span>
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          All {complete} shipments have their customer send-out docs on Trello.
        </p>
      )}
    </div>
  );
}
