"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { fmtKg, relativeTime } from "./format";
import type { Freshness } from "@/lib/digest/types";

interface PlantStatusHeaderProps {
  operationalDate: string | null;
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
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Operational-date bar. Left: the date + weekday. Middle: kg fed. Right:
 * last-sync freshness (ticks client-side) + a streams-behind note. Mirrors the
 * digest's glass-card idiom.
 *
 * WHAT LEFT, AND WHY (2026-08-28). This band used to open with a running/rest
 * BEACON and carry "Planned setup" + "Projected out" beside the fed figure, all
 * read from the `production_schedule` plan. The plan was retired as redundant
 * with Renzo's Google Sheet, and none of the three is derivable from activity:
 * `fedKg` on the operational date is normally 0 because RC Out is filed the
 * following morning, so a beacon driven off it would announce "plant at rest" on
 * an ordinary working day. A confident wrong status is worse than no status, so
 * the band reports only what it can observe. See `_archived/prod-schedule-v1/`.
 */
export function PlantStatusHeader({
  operationalDate,
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

  const dow = dowNameFor(operationalDate);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-card/95 p-3.5 backdrop-blur supports-backdrop-filter:bg-card/70 animate-fade-up sm:gap-x-5 sm:p-4">
      {/* Operational day */}
      <div className="flex flex-col">
        <span className="text-base font-semibold tracking-tight">
          {dow ? `${dow} ` : ""}
          {operationalDate ?? "—"}
        </span>
        <span className="text-xs text-muted-foreground">operational day</span>
      </div>

      <div className="hidden h-9 w-px self-center bg-border sm:block" />

      <Fact label="Fed (RC Out)">
        <span className="font-mono">{fmtKg(fedKg)} </span>
        <span className="text-xs font-normal text-muted-foreground">kg</span>
      </Fact>

      <div className="hidden flex-1 sm:block" />

      <div className="flex w-full flex-col items-start gap-1 text-left sm:w-auto sm:items-end sm:text-right">
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
