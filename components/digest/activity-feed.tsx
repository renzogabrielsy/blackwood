"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { relativeTime, diffValue } from "./format";
import type { ActivityItem } from "@/lib/digest/types";

interface ActivityFeedProps {
  activity: ActivityItem[];
}

const OP_STYLES: Record<
  ActivityItem["operation"],
  { label: string; cls: string }
> = {
  INSERT: {
    label: "INSERT",
    cls: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  },
  UPDATE: {
    label: "UPDATE",
    cls: "bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  DELETE: {
    label: "DELETE",
    cls: "bg-red-500/12 text-red-700 dark:text-red-300",
  },
};

function employeeLabel(key: string): string {
  switch (key) {
    case "gsheet-sync":
      return "GSheet";
    case "deliveries-manager":
      return "Deliveries";
    case "rc-out-manager":
      return "RC Out";
    case "production-manager":
      return "Production";
    case "other":
      return "System";
    default:
      return key;
  }
}

const NOTE_TRUNCATE = 120;

function ActivityRow({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = React.useState(false);
  const op = OP_STYLES[item.operation];
  const longNote = item.note.length > NOTE_TRUNCATE;
  const noteText =
    longNote && !expanded ? item.note.slice(0, NOTE_TRUNCATE) + "…" : item.note;

  return (
    <li className="group flex gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40">
      {/* op pill rail */}
      <div className="flex w-[64px] shrink-0 flex-col items-start gap-1 pt-0.5">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
            op.cls
          )}
        >
          {op.label}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {relativeTime(item.at)}
        </span>
      </div>

      {/* body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full border bg-background px-1.5 py-0.5 text-[10px] font-medium">
            {employeeLabel(item.employee)}
          </span>
          {item.provenance && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {item.provenance}
            </span>
          )}
          <span className="font-mono text-[11px] text-muted-foreground">
            {item.table}
          </span>
        </div>

        {item.note && (
          <p
            className={cn(
              "mt-1 text-xs leading-relaxed text-foreground/90",
              longNote && "cursor-pointer"
            )}
            onClick={longNote ? () => setExpanded((v) => !v) : undefined}
          >
            {noteText}
            {longNote && (
              <span className="ml-1 text-[10px] font-medium text-muted-foreground">
                {expanded ? "(less)" : "(more)"}
              </span>
            )}
          </p>
        )}

        {item.diff.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {item.diff.map((d, i) => (
              <span
                key={`${item.id}-${d.field}-${i}`}
                className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px]"
              >
                <span className="text-muted-foreground">{d.field}</span>
                <span className="text-red-600/80 line-through dark:text-red-400/80">
                  {diffValue(d.old)}
                </span>
                <span className="text-muted-foreground">→</span>
                <span className="text-emerald-700 dark:text-emerald-300">
                  {diffValue(d.new)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Activity feed — "what the last sync scraped". Up to ~40 most-recent audit
 * events as a clean changelog. NOT animated per-row (can be 40+ items — the
 * "never animate 100+ instances" spirit); a single container fade is fine.
 *
 * NOTE: ActivityItem.id is an opaque hashed int — used ONLY as a React key.
 */
export function ActivityFeed({ activity }: ActivityFeedProps) {
  if (!activity.length) {
    return (
      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        No recent sync activity.
      </div>
    );
  }

  return (
    <div className="animate-fade-up overflow-hidden rounded-xl border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
        <h3 className="text-sm font-semibold tracking-tight">
          What the last sync brought in
        </h3>
        <span className="font-mono text-[11px] text-muted-foreground">
          {activity.length} events
        </span>
      </div>
      <ul className="max-h-[520px] divide-y divide-border overflow-y-auto scroll-fade-bottom">
        {activity.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
