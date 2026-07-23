// Pure, server-safe presentation helpers shared by the list + detail pages.
// No 'use client' — no interactivity, no hooks. Renders the per-customer readiness
// verdict as a compact chip. No ₱ in this domain → nothing gated.

import { CheckCircle2, CircleAlert, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Readiness } from "@/lib/shipments/types";

/** Compact readiness chip: ✅ complete (green) · N/M (amber) · unknown (muted). */
export function ReadinessChip({ readiness, className }: { readiness: Readiness; className?: string }) {
  if (!readiness.hasRequirementSet) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground",
          className
        )}
      >
        <HelpCircle className="h-3 w-3" />
        {readiness.customer ?? "Unknown"} · no doc set
      </span>
    );
  }

  const total = readiness.required.length;
  const present = total - readiness.missing.length;

  if (readiness.complete) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400",
          className
        )}
      >
        <CheckCircle2 className="h-3 w-3" />
        Complete
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-400",
        className
      )}
    >
      <CircleAlert className="h-3 w-3" />
      {present}/{total}
    </span>
  );
}

/** Aggregate checklist progress bar (done/total across all card checklists). */
export function ChecklistBar({ done, total }: { done: number; total: number }) {
  if (total === 0) return <span className="text-[11px] text-muted-foreground">no checklist</span>;
  const pct = Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", done === total ? "bg-emerald-500" : "bg-primary")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
    </div>
  );
}
