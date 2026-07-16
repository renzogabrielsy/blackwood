"use client";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fmtKg } from "./format";
import type { TruckTrip } from "@/lib/digest/types";

interface TrucksSummaryProps {
  trucks: TruckTrip[];
}

/** Whole-number with thousands separators (km / L share fmtKg's integer style). */
function fmtNum(value: number): string {
  return fmtKg(value);
}

/**
 * Trucks with a trip — a compact, dense Excel-Standard table of every truck
 * that logged distance (ttl_km > 0) on the operational date, busiest first.
 * Renders NOTHING when no truck moved that day (matches how other bands skip
 * empty content rather than show a hollow card).
 */
export function TrucksSummary({ trucks }: TrucksSummaryProps) {
  if (!trucks.length) return null;

  return (
    <div className="hover-lift flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">
          Trucks with a trip
        </h3>
        <span className="font-mono text-[11px] text-muted-foreground">
          {trucks.length} truck{trucks.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="border-b bg-muted/60">
              <th className="w-auto px-2 py-1 text-left font-medium text-muted-foreground">
                Plate
              </th>
              <th className="w-[110px] px-2 py-1 text-right font-medium text-muted-foreground">
                Distance (km)
              </th>
              <th className="w-[90px] px-2 py-1 text-right font-medium text-muted-foreground">
                Fuel (L)
              </th>
            </tr>
          </thead>
          <tbody>
            {trucks.map((t, i) => (
              <tr
                key={`${t.plateNo}-${i}`}
                className="h-8 border-b last:border-0 transition-all duration-150 hover:bg-muted/40"
              >
                <td className="max-w-[200px] truncate px-2 py-1 font-medium">
                  {t.remarks ? (
                    // Tap-native Popover (not a hover-only Tooltip) so truck
                    // remarks are reachable on touch devices as well as by mouse.
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="cursor-pointer underline decoration-dotted decoration-muted-foreground/50 underline-offset-2"
                        >
                          {t.plateNo}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        side="bottom"
                        align="start"
                        className="w-auto max-w-[240px] p-2 text-xs"
                      >
                        {t.remarks}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    t.plateNo
                  )}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {fmtNum(t.ttlKm)}
                </td>
                <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                  {t.fuelLiters == null ? "—" : fmtNum(t.fuelLiters)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
