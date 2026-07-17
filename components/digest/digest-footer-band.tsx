import {
  AlertTriangle,
  CircleAlert,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtKg } from "./format";
import type {
  Flag,
  StreamFreshness,
  MonthToDate,
} from "@/lib/digest/types";

// ---------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------

const SEVERITY: Record<
  Flag["severity"],
  { cls: string; Icon: typeof Info; label: string }
> = {
  info: {
    cls: "border-sky-500/30 bg-sky-500/8 text-sky-700 dark:text-sky-300",
    Icon: Info,
    label: "Info",
  },
  warn: {
    cls: "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-300",
    Icon: AlertTriangle,
    label: "Warning",
  },
  critical: {
    cls: "border-red-500/30 bg-red-500/8 text-red-700 dark:text-red-300",
    Icon: CircleAlert,
    label: "Critical",
  },
};

function Flags({ flags }: { flags: Flag[] }) {
  if (!flags.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
        <Info className="size-3.5" />
        No flags — all streams reconcile cleanly.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {flags.map((f, i) => {
        const s = SEVERITY[f.severity];
        return (
          <div
            key={`${f.kind}-${i}`}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
              s.cls
            )}
          >
            <s.Icon className="mt-0.5 size-3.5 shrink-0" />
            <span className="leading-relaxed">{f.message}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------
// Stream freshness table (Excel-standard density)
// ---------------------------------------------------------------------

function StreamTable({ streams }: { streams: StreamFreshness[] }) {
  // Never crush, always scroll: 110 + 52 fixed = 162px + a 138px floor for the
  // flexible Stream label → 300px, scrolled by the wrapper when narrower.
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[300px] table-fixed text-xs">
        <thead>
          <tr className="border-b bg-muted/60">
            <th className="w-auto px-2 py-1 text-left font-medium text-muted-foreground">
              Stream
            </th>
            <th className="w-[110px] px-2 py-1 text-right font-medium text-muted-foreground">
              Through
            </th>
            <th className="w-[52px] px-2 py-1 text-center font-medium text-muted-foreground">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {streams.length === 0 ? (
            <tr>
              <td
                colSpan={3}
                className="px-2 py-3 text-center text-muted-foreground"
              >
                No streams reporting.
              </td>
            </tr>
          ) : (
            streams.map((s) => (
              <tr
                key={s.stream}
                className="h-8 border-b last:border-0 transition-all duration-150 hover:bg-muted/40"
              >
                <td className="truncate px-2 py-1">{s.label}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {s.throughDate ?? "—"}
                </td>
                <td className="px-2 py-1">
                  <div className="flex items-center justify-center">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        s.status === "ok"
                          ? "bg-emerald-500"
                          : "bg-amber-500"
                      )}
                      title={s.status === "ok" ? "Current" : "Lagging"}
                    />
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------
// Month-to-date card
// ---------------------------------------------------------------------

function MtdRow({
  label,
  value,
  neutral,
}: {
  label: string;
  value: number;
  neutral?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          neutral && "text-muted-foreground"
        )}
      >
        {fmtKg(value)}
        <span className="ml-1 text-[10px] text-muted-foreground">kg</span>
      </span>
    </div>
  );
}

function MtdCard({ mtd }: { mtd: MonthToDate }) {
  return (
    <div className="flex flex-col rounded-lg border bg-card/95 p-3.5 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold tracking-tight">Month to date</h3>
        <span className="text-[11px] text-muted-foreground">
          {mtd.label || "—"}
        </span>
      </div>
      <div className="divide-y divide-border">
        <MtdRow label="RC In" value={mtd.rcInKg} />
        <MtdRow label="RC Out" value={mtd.rcOutKg} />
        <MtdRow label="Production" value={mtd.productionKg} />
        <MtdRow label="Net (In − Out)" value={mtd.netKg} neutral />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------

interface DigestFooterBandProps {
  flags: Flag[];
  streams: StreamFreshness[];
  monthToDate: MonthToDate;
}

export function DigestFooterBand({
  flags,
  streams,
  monthToDate,
}: DigestFooterBandProps) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Flags
        </h3>
        <Flags flags={flags} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Stream freshness
        </h3>
        <StreamTable streams={streams} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cycle roll-up
        </h3>
        <MtdCard mtd={monthToDate} />
      </div>
    </div>
  );
}
