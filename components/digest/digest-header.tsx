"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { relativeTime } from "./format";
import type { Freshness } from "@/lib/digest/types";

interface DigestHeaderProps {
  operationalDate: string | null;
  lastSyncAt: string | null;
  freshness: Freshness;
}

const FRESHNESS_STYLES: Record<
  Freshness,
  { dot: string; text: string; ring: string; label: string }
> = {
  fresh: {
    dot: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
    ring: "ring-emerald-500/20",
    label: "Fresh",
  },
  recent: {
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
    ring: "ring-amber-500/20",
    label: "Recent",
  },
  stale: {
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    ring: "ring-border",
    label: "Stale",
  },
};

/**
 * Sub-band header (NOT a page title — navbar owns that). Left: operational
 * date. Right: a glass freshness pill colored by sync recency. Relative
 * time is recomputed on the client so it stays accurate after hydration.
 */
export function DigestHeader({
  operationalDate,
  lastSyncAt,
  freshness,
}: DigestHeaderProps) {
  const styles = FRESHNESS_STYLES[freshness];

  // Recompute relative time on the client (and tick once a minute).
  const [rel, setRel] = React.useState(() => relativeTime(lastSyncAt));
  React.useEffect(() => {
    setRel(relativeTime(lastSyncAt));
    const id = setInterval(() => setRel(relativeTime(lastSyncAt)), 60_000);
    return () => clearInterval(id);
  }, [lastSyncAt]);

  return (
    <div className="flex flex-wrap items-end justify-between gap-3 animate-fade-up">
      <div className="flex flex-col">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Daily Sync Digest
        </span>
        <span className="text-2xl font-semibold tracking-tight tabular-nums">
          As of {operationalDate ?? "—"}
        </span>
      </div>

      <div
        className={cn(
          "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ring-1",
          "bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/60",
          styles.ring,
          styles.text
        )}
      >
        <span className="relative flex h-2 w-2">
          {freshness === "fresh" && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                styles.dot
              )}
            />
          )}
          <span
            className={cn("relative inline-flex h-2 w-2 rounded-full", styles.dot)}
          />
        </span>
        <span>
          {styles.label} · synced {rel}
        </span>
      </div>
    </div>
  );
}
