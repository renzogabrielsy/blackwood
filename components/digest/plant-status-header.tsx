"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { fmtKg, relativeTime } from "./format";
import { BEACON_DOT } from "./status-tokens";
import type { Freshness, PlantStatus } from "@/lib/digest/types";

interface PlantStatusHeaderProps {
  operationalDate: string | null;
  /** the operational date's plant status (null outside the ingested plan window) */
  plantStatus: PlantStatus | null;
  /** kg fed on the operational date (RC Out KPI value) */
  fedKg: number;
  lastSyncAt: string | null;
  freshness: Freshness;
  /** how many streams are lagging (warn) — surfaced as a small note */
  streamsBehind: number;
}

const FRESHNESS_CHIP: Record<Freshness, string> = {
  fresh: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  recent: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  stale: "bg-muted text-muted-foreground",
};

const DOW_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Weekday name for a yyyy-MM-dd date (UTC). */
function dowNameFor(date: string | null): string {
  if (!date) return "";
  return DOW_NAMES[new Date(date + "T00:00:00Z").getUTCDay()] ?? "";
}

function Fact({
  label,
  children,
  plan,
}: {
  label: string;
  children: React.ReactNode;
  plan?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        {label}
      </span>
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          plan && "text-violet-600 dark:text-violet-300"
        )}
      >
        {children}
      </span>
    </div>
  );
}

/**
 * Operational-date status bar. Left: a running/rest beacon + the date.
 * Middle: planned setup, projected tons, fed kg. Right: last-sync freshness
 * (ticks client-side) + a streams-behind note. Mirrors the digest's
 * glass-card idiom. Sourced from `plantStatus` (the `production_schedule`
 * plan) + `meta`.
 */
export function PlantStatusHeader({
  operationalDate,
  plantStatus,
  fedKg,
  lastSyncAt,
  freshness,
  streamsBehind,
}: PlantStatusHeaderProps) {
  const [rel, setRel] = React.useState(() => relativeTime(lastSyncAt));
  React.useEffect(() => {
    setRel(relativeTime(lastSyncAt));
    const id = setInterval(() => setRel(relativeTime(lastSyncAt)), 60_000);
    return () => clearInterval(id);
  }, [lastSyncAt]);

  const hasPlan = plantStatus != null;
  const isRest = hasPlan && plantStatus.shifts === 0;
  const running = hasPlan ? plantStatus.running : false;

  const beaconLabel = !hasPlan
    ? "Plant status · no plan on record"
    : isRest
      ? "Plant at rest · planned"
      : `Plant running · ${plantStatus.shifts} shift${plantStatus.shifts === 1 ? "" : "s"}`;

  const dow = dowNameFor(operationalDate);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70 animate-fade-up">
      {/* Beacon + date */}
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5">
          {running && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                BEACON_DOT.run
              )}
            />
          )}
          <span
            className={cn(
              "relative inline-flex h-2.5 w-2.5 rounded-full",
              running ? BEACON_DOT.run : BEACON_DOT.rest
            )}
          />
        </span>
        <div className="flex flex-col">
          <span className="text-base font-semibold tracking-tight">
            {beaconLabel}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {dow ? `${dow} ` : ""}
            {operationalDate ?? "—"} · operational day
          </span>
        </div>
      </div>

      <div className="hidden h-9 w-px self-center bg-border sm:block" />

      <Fact label="Planned setup" plan>
        {hasPlan ? plantStatus.setup ?? "— off —" : "—"}
      </Fact>
      <Fact label="Projected out" plan>
        {hasPlan && plantStatus.projectedTons != null
          ? `${plantStatus.projectedTons.toFixed(1)} `
          : "— "}
        <span className="text-xs font-normal text-muted-foreground">t</span>
      </Fact>
      <Fact label="Fed (RC Out)">
        <span className="font-mono">{fmtKg(fedKg)} </span>
        <span className="text-xs font-normal text-muted-foreground">kg</span>
      </Fact>

      <div className="flex-1" />

      <div className="flex flex-col items-end gap-1 text-right">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            Last sync{" "}
            <span className="font-medium text-foreground/80">{rel}</span>
          </span>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
              FRESHNESS_CHIP[freshness]
            )}
          >
            {freshness}
          </span>
        </div>
        {streamsBehind > 0 && (
          <span className="text-[11px] text-amber-700 dark:text-amber-300">
            {streamsBehind} stream{streamsBehind === 1 ? "" : "s"} behind — see
            cards
          </span>
        )}
      </div>
    </div>
  );
}
