import { cn } from "@/lib/utils";
import type { SyncRun } from "@/lib/digest/types";

interface SyncSummaryProps {
  latestSync: SyncRun | null;
}

/** Friendly label for an ingestion "employee" key. */
function employeeLabel(key: string): string {
  switch (key) {
    case "gsheet-sync":
      return "GSheet Sync";
    case "deliveries-manager":
      return "Deliveries";
    case "rc-out-manager":
      return "RC Out";
    case "production-manager":
      return "Production";
    case "other":
      return "Other";
    default:
      return key;
  }
}

/**
 * Compact header summarizing what the most recent sync run brought in:
 * "{date} · {n} new · {n} updated" plus per-employee count chips.
 * Server component — no interactivity.
 */
export function SyncSummary({ latestSync }: SyncSummaryProps) {
  if (!latestSync) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
        No sync runs recorded yet.
      </div>
    );
  }

  const { date, insertCount, updateCount, deleteCount, byEmployee } =
    latestSync;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-mono font-medium tabular-nums">{date}</span>
        <span className="text-muted-foreground">·</span>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {insertCount.toLocaleString("en-US")}
          </span>
          <span className="text-muted-foreground">new</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400">
            {updateCount.toLocaleString("en-US")}
          </span>
          <span className="text-muted-foreground">updated</span>
        </span>
        {deleteCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <span className="font-mono font-semibold tabular-nums text-red-600 dark:text-red-400">
              {deleteCount.toLocaleString("en-US")}
            </span>
            <span className="text-muted-foreground">removed</span>
          </span>
        )}
      </div>

      {byEmployee.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {byEmployee.map((e) => (
            <span
              key={e.employee}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5",
                "text-[11px] font-medium"
              )}
            >
              {employeeLabel(e.employee)}
              <span className="font-mono tabular-nums text-muted-foreground">
                {e.count.toLocaleString("en-US")}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
