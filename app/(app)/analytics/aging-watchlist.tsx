"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE AGING WATCHLIST — the piles to go and look at, right now.
//
// Unlike everything else on this page it is not a history. It is a LIVE list of
// named piles, oldest first, and it exists because "the yard averages 387 days"
// is a number you cannot act on while "JULY-23-BLK4, 58 t, B-7B, 1,158 days" is
// a number you can walk out to.
//
// ── THREE THINGS THE COPY OWES ITS READER ────────────────────────────────────
//
// 1. **"Open" is wider than "in use", deliberately.** Measured 2026-09-01: only
//    three piles over a tonne are actively being fed, holding 92 t, while 167
//    STORED piles hold 10,401 t that are doing nothing but get older. An
//    IN-USE-only list would show three names and miss ten and a half million
//    kilos — precisely what the list exists to find. `status` rides as a column
//    so the split is still visible.
//
// 2. **Closed-block residue is EXCLUDED, and said so out loud.** A closed block
//    keeps a small logged remainder forever; that is the charcoal that
//    evaporated — resiko — and it is expected, never something to act on
//    (Renzo's standing rule). Counting it made the yard read 416 days old with
//    a six-year-old pile in it. It is disclosed beside the headline rather than
//    hidden, because a number with an invisible exclusion is worse than a
//    bigger one.
//
// 3. **The headline is the SQL layer's, not a sum of the rows.** `open_kg` and
//    `wtd_age_days` come from the newest `view_analytics_aging_eom` row, which
//    covers the same population and was measured equal to the kilo. Re-adding
//    the visible rows here would create a second definition of how much
//    charcoal is in the yard — and a wrong one the moment the list is capped.
//
// Every row deep-links into the Blocking grid at `?block=<block_loc>`, which is
// that route's own selection param, so "go and look at it" is one click.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgingWatchlist as AgingWatchlistData } from "@/lib/analytics/types";

/** How many rows before the reader has to ask for more. */
const TOP_N = 10;

/**
 * Only a real warehouse slot is a link. `location_ref` also holds feed-area
 * labels that the 220-slot grid has no cell for, and a link to a block that
 * cannot be selected is worse than plain text.
 */
const LINKABLE_BLOCK = /^(?:[A-D]-|PC[AB]-)/i;

function t1(kg: number | null): string {
  if (kg == null) return "—";
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function n(value: number | null, decimals: number): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function Stat({
  label,
  value,
  unit,
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border bg-background/40 px-2.5 py-1.5" title={title}>
      <div className="truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="truncate font-mono text-sm font-semibold tabular-nums">
          {value}
        </span>
        {unit && (
          <span className="shrink-0 text-[10px] text-muted-foreground">{unit}</span>
        )}
      </div>
    </div>
  );
}

export interface AgingWatchlistProps {
  watchlist: AgingWatchlistData;
  canViewPrices: boolean;
}

export function AgingWatchlist({ watchlist, canViewPrices }: AgingWatchlistProps) {
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? watchlist.items : watchlist.items.slice(0, TOP_N);
  const hidden = watchlist.items.length - shown.length;

  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide">
            Piles to go and look at
          </h2>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Every open pile holding more than a tonne, oldest first. Charcoal
            keeps losing weight the longer it sits, and the money already spent
            on it does not shrink with it.
          </p>
        </div>
        {watchlist.asOfDate && (
          <span className="shrink-0 text-[10.5px] text-muted-foreground">
            live · <span className="font-mono">{watchlist.asOfDate}</span>
          </span>
        )}
      </header>

      <div className="rounded-lg border bg-card">
        {/* ── Headline — the SQL layer's own totals, not a sum of the rows ── */}
        <div className="grid grid-cols-2 gap-2 border-b p-2 sm:grid-cols-4">
          <Stat
            label="Open stock"
            value={t1(watchlist.openKg)}
            unit="t"
            title="Everything standing in piles that have not been closed out. Closed-block residue is not in here."
          />
          <Stat
            label="Weighted age"
            value={n(watchlist.wtdAgeDays, 0)}
            unit="days"
            title="The average age of a kilo in the yard, weighted by weight — a big fresh pile pulls it down, a small old one barely moves it."
          />
          <Stat
            label="Over 120 days"
            value={n(watchlist.pctOver120d, 1)}
            unit="%"
            title="The share of open stock sitting in piles older than four months."
          />
          <Stat
            label="Oldest pile"
            value={n(watchlist.oldestAgeDays, 0)}
            unit="days"
            title="The age of the single oldest open pile."
          />
        </div>

        {watchlist.items.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            No open pile is holding more than a tonne.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full table-fixed text-xs"
              style={{ minWidth: 640, borderCollapse: "separate", borderSpacing: 0 }}
            >
              <colgroup>
                <col style={{ width: 168 }} />
                <col style={{ width: 84 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 84 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 108 }} />
              </colgroup>
              <thead>
                <tr className="h-7 border-b">
                  {[
                    ["Batch", "text-left"],
                    ["Block", "text-left"],
                    ["Status", "text-left"],
                    ["Age", "text-right"],
                    ["Balance", "text-right"],
                    ["₱/kg", "text-right"],
                    ["Value", "text-right"],
                  ].map(([label, align]) => (
                    <th
                      key={label}
                      scope="col"
                      className={cn(
                        "border-b bg-muted px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
                        align,
                      )}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const linkable =
                    item.blockLoc != null && LINKABLE_BLOCK.test(item.blockLoc);
                  return (
                    <tr
                      key={item.batchId}
                      className="h-8 border-b transition-all duration-150 last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-2 py-1">
                        <span className="block truncate font-mono text-[11px] font-medium">
                          {item.batchCode}
                        </span>
                      </td>
                      <td className="px-2 py-1">
                        {linkable ? (
                          <Link
                            href={`/inventory/blocking?block=${encodeURIComponent(item.blockLoc!)}`}
                            title={`Open ${item.blockLoc} in the Blocking grid`}
                            className="inline-flex max-w-full items-center gap-0.5 rounded font-mono text-[11px] text-foreground underline-offset-2 transition-colors duration-150 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span className="truncate">{item.blockLoc}</span>
                            <ArrowUpRight
                              aria-hidden
                              className="size-2.5 shrink-0 text-muted-foreground"
                            />
                          </Link>
                        ) : (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground">
                            {item.blockLoc ?? "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <span className="inline-flex items-center rounded border border-border/70 px-1 text-[9.5px] uppercase leading-[15px] tracking-wide text-muted-foreground">
                          {item.status ?? "—"}
                        </span>
                      </td>
                      <td
                        className="px-2 py-1 text-right font-mono text-[11px] tabular-nums"
                        title="Weight-weighted average age of everything tipped into this pile. There is no first-in-first-out accounting — the feeding records say which pile kilos left, never which truckload within it."
                      >
                        {n(item.ageDays, 0)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-[11px] tabular-nums">
                        {t1(item.balanceKg)}
                        <span className="ml-0.5 text-[9.5px] text-muted-foreground">
                          t
                        </span>
                      </td>
                      <td className="px-2 py-1">
                        {canViewPrices ? (
                          <div
                            className="flex items-baseline justify-between gap-1 font-mono text-[11px] tabular-nums"
                            title={
                              item.hasUnpricedDelivery
                                ? `${item.unpricedDeliveryCount} of this pile's ${item.deliveryCount} truckloads is still awaiting a price, so this average covers only the priced ones.`
                                : undefined
                            }
                          >
                            <span className="shrink-0 text-[9.5px] text-muted-foreground">
                              ₱
                            </span>
                            <span className="truncate">
                              {n(item.deliveredPhpKg, 2)}
                              {item.hasUnpricedDelivery && (
                                <span
                                  aria-label="partly unpriced"
                                  className="ml-px text-[9.5px] text-muted-foreground"
                                >
                                  ~
                                </span>
                              )}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1 font-mono text-[11px] text-muted-foreground/60">
                            <Lock className="size-2.5" aria-hidden />—
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {canViewPrices ? (
                          <div className="flex items-baseline justify-between gap-1 font-mono text-[11px] tabular-nums">
                            <span className="shrink-0 text-[9.5px] text-muted-foreground">
                              ₱
                            </span>
                            <span className="truncate">{n(item.valuePhp, 0)}</span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1 font-mono text-[11px] text-muted-foreground/60">
                            <Lock className="size-2.5" aria-hidden />—
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {watchlist.items.length > TOP_N && (
          <div className="border-t px-2 py-1.5">
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className="cursor-pointer rounded text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAll
                ? `Show the ${TOP_N} oldest only`
                : `Show all ${watchlist.items.length} piles (${hidden} more)`}
            </button>
          </div>
        )}
      </div>

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        <strong className="font-medium text-foreground">
          Closed blocks are not on this list.
        </strong>{" "}
        {watchlist.closedResidueKg != null && watchlist.closedResidueBatches != null
          ? `Their ${t1(watchlist.closedResidueKg)} t of leftover weight across ${watchlist.closedResidueBatches} blocks is the charcoal that evaporated — resiko — which is expected and is never something to go and act on.`
          : "Their leftover weight is the charcoal that evaporated — resiko — which is expected and is never something to go and act on."}{" "}
        &ldquo;Open&rdquo; here means anything not closed, not just what is being
        fed today: only a handful of piles are actively in use, while the rest sit
        in storage getting older.
        {canViewPrices &&
          " Value is what a pile COST us, not what it would fetch — and it does not include the extra cost of the weight it has already lost."}
        {watchlist.truncated &&
          " This list came back at the database read limit, so it may be short of the full set."}
      </p>
    </section>
  );
}
