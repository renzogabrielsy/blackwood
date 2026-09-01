"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE BATCH-BASIS MONEY PANEL — one column per PRODUCTION CAMPAIGN.
//
// ── WHY A SECOND TABLE EXISTS AT ALL ─────────────────────────────────────────
// Renzo's decision 2 of 2026-09-01: BOTH bases, side by side and labelled. The
// matrix above is the CALENDAR read — January means the days in January, which
// is the right basis for a market price. A production campaign is the COST
// read, because a campaign is the unit the plant actually runs and it routinely
// crosses a month boundary: AUGUST closed and SEPTEMBER opened on the same day,
// 2026-08-29. "What did August the MONTH cost" and "what did AUGUST the
// CAMPAIGN cost" are two different, both-correct answers, and the header says
// so in as many words rather than leaving the reader to work it out.
//
// It is a separate table rather than more matrix columns because the AXIS is
// different. Folding campaigns into the period axis would mean a column that is
// neither a month nor a quarter, sitting beside columns that are.
//
// ── THE STAR NUMBER ──────────────────────────────────────────────────────────
// `upliftPhpKg`. Charcoal loses weight while it sits, but the money already
// spent does not shrink with it, so every kilo that actually reached the plant
// cost MORE than the arrival price. The gap between the arrival row and the
// true row IS that cost, and the uplift row prints it directly. July 2026:
// ₱46.09 on arrival, ₱48.26 by the time it was fed — ₱2.17 a kilo of storage
// time on 4.50% weight loss.
//
// ── LAYOUT: the same two platform rules the matrix obeys ─────────────────────
//   • **"Never crush, always scroll"** — `table-fixed`, `width: max-content`, a
//     full `<colgroup>` of explicit pixel widths, wrapped in `overflow-x-auto`.
//     No flexible column; the flexible one is the one that silently crushes.
//   • **Frozen panes are OPAQUE** — the row-label column is sticky-left over
//     scrolling cells, so it paints a SOLID token (never a `/opacity`, never a
//     backdrop-blur) and `.frozen-edge` kills the seam.
// The panel opens scrolled to its RIGHT edge, because the campaign anyone
// wants is the current one and 32 columns start in 2024.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Lock, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { estimateTitle } from "@/lib/analytics/format";
import type { CampaignCost } from "@/lib/analytics/types";

// Explicit pixel widths — the sum below IS the table's minWidth.
const W_LABEL = 208;
const W_CAMPAIGN = 116;

type Format = "tonnes" | "php" | "pct" | "count";

interface PanelRow {
  key: string;
  label: string;
  sublabel: string;
  format: Format;
  decimals: number;
  /** ₱-bearing: nulled server-side for a price-denied role, renders locked. */
  price: boolean;
  /** The number the panel exists for — printed heavier, with a rule above it. */
  star?: boolean;
  value(c: CampaignCost): number | null;
  /** The figure is measured over only PART of the campaign. Marks the cell `~`. */
  estimated?(c: CampaignCost): boolean;
  /** The row-label hover: what it is, and what it leaves out. */
  title: string;
  /** Why THIS campaign's cell is blank, when it is. */
  blankTitle?(c: CampaignCost): string;
}

/** "17 of 20 blocks closed, 16 priced" — the sentence a blank owes its reader. */
function coverageSentence(c: CampaignCost): string {
  if (c.blocksFed == null) {
    return "This campaign has not fed anything yet, so there is nothing to price.";
  }
  return `${c.blocksClosed ?? 0} of ${c.blocksFed} blocks closed, ${c.blocksInPrice ?? 0} fully priced.`;
}

const TRUE_PRICE_BLANK =
  "The true price only exists once EVERY block the campaign fed has been closed AND priced — an open block has no final fed total, and a block with a truckload still awaiting its price has money missing from the sum. Blank rather than wrong.";

const ROWS: readonly PanelRow[] = [
  {
    key: "fed_kg",
    label: "Charcoal fed",
    sublabel: "tonnes",
    format: "tonnes",
    decimals: 1,
    price: false,
    value: (c) => (c.fedKg == null ? null : c.fedKg / 1000),
    title:
      "Everything this campaign fed to the plant, across every day it ran — which is not the same set of days as the calendar month it is named after.",
  },
  {
    key: "delivered",
    label: "Delivered ₱/kg fed",
    sublabel: "arrival cost",
    format: "php",
    decimals: 2,
    price: true,
    value: (c) => c.deliveredPhpKgFed,
    estimated: (c) => c.fedPriceCoveragePct != null && c.fedPriceCoveragePct < 100,
    title:
      "What the charcoal this campaign fed cost on the day it arrived at the gate. A weighted average over the kilos fed, never the mean of the daily prices.",
  },
  {
    key: "true",
    label: "True ₱/kg fed",
    sublabel: "campaign-weighted",
    format: "php",
    decimals: 2,
    price: true,
    value: (c) => c.campaignWeightedActualFedPhpKg,
    estimated: (c) => !c.isFullyCovered,
    title:
      "What that charcoal REALLY cost by the time it was fed. The campaign-weighted version is the one to compare against the arrival price — it is attributed to this campaign's own kilos, so the two are like for like.",
    blankTitle: (c) => `${TRUE_PRICE_BLANK} ${coverageSentence(c)}`,
  },
  {
    key: "uplift",
    label: "Cost of storage time",
    sublabel: "₱/kg the weight loss added",
    format: "php",
    decimals: 2,
    price: true,
    star: true,
    value: (c) => c.upliftPhpKg,
    estimated: (c) => !c.isFullyCovered,
    title:
      "The gap between the two prices above — literally what it cost to let the charcoal sit. Charcoal dries out and loses weight, the money already spent does not shrink, so the same pesos end up spread over fewer kilos.",
    blankTitle: (c) => `${TRUE_PRICE_BLANK} ${coverageSentence(c)}`,
  },
  {
    key: "loss",
    label: "Weight lost",
    sublabel: "% of delivered kg",
    format: "pct",
    decimals: 2,
    price: false,
    value: (c) => (c.lossPct == null ? null : c.lossPct * 100),
    title:
      "How much weight the blocks this campaign fed lost while they sat, as a share of what was delivered into them. Physical, so it needs no price and uses every block.",
  },
  {
    key: "produced",
    label: "Produced",
    sublabel: "tonnes",
    format: "tonnes",
    decimals: 1,
    price: false,
    value: (c) => (c.producedKg == null ? null : c.producedKg / 1000),
    title:
      "Finished product out the other end, for this campaign. Blank before November 2025 — production reporting did not exist yet, and a zero would read as a plant that made nothing.",
  },
  {
    key: "yield",
    label: "Yield",
    sublabel: "% of fed kilos",
    format: "pct",
    decimals: 1,
    price: false,
    value: (c) => (c.yieldPct == null ? null : c.yieldPct * 100),
    title:
      "How much finished product came out of every hundred kilos fed in, for this campaign.",
  },
  {
    key: "ppp_delivered",
    label: "₱ per produced kg",
    sublabel: "arrival basis",
    format: "php",
    decimals: 2,
    price: true,
    value: (c) => c.phpPerProducedKgDelivered,
    title:
      "What one kilo of finished product cost in charcoal, priced at what the charcoal cost on arrival. Charcoal only — no labour, power, bags or depreciation.",
    blankTitle: (c) =>
      c.producedKg == null
        ? "Production was not being reported for this campaign, so there is no denominator."
        : "Some of this campaign's kilos were fed out of piles with no delivery record at all, so the charcoal bill is missing money. Blank rather than understated.",
  },
  {
    key: "ppp_true",
    label: "₱ per produced kg",
    sublabel: "TRUE basis",
    format: "php",
    decimals: 2,
    price: true,
    star: true,
    value: (c) => c.phpPerProducedKgTrue,
    title:
      "The number this whole layer was built for: what one kilo of finished product cost in charcoal AFTER paying for the weight that evaporated in the yard.",
    blankTitle: (c) =>
      c.producedKg == null
        ? "Production was not being reported for this campaign, so there is no denominator."
        : `${TRUE_PRICE_BLANK} ${coverageSentence(c)}`,
  },
];

function fmt(row: PanelRow, v: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: row.decimals,
    maximumFractionDigits: row.decimals,
  });
}

function exactTitle(row: PanelRow, v: number): string {
  const n = fmt(row, v);
  switch (row.format) {
    case "php":
      return `₱${n} / kg`;
    case "tonnes":
      return `${n} t`;
    case "pct":
      return `${n}%`;
    default:
      return n;
  }
}

function CampaignCell({
  row,
  campaign,
  restricted,
}: {
  row: PanelRow;
  campaign: CampaignCost;
  restricted: boolean;
}) {
  if (restricted) {
    return (
      <td
        className="border-l px-2 py-1"
        title="₱ figures are withheld for your role. Nothing was sent to this browser."
      >
        <div className="flex h-4 items-center justify-end gap-1 font-mono text-[11px] text-muted-foreground/60">
          <Lock className="size-2.5" aria-hidden />
          <span>—</span>
        </div>
      </td>
    );
  }

  const v = row.value(campaign);
  if (v == null) {
    return (
      <td
        className="border-l px-2 py-1"
        title={
          row.blankTitle?.(campaign) ??
          "No figure for this campaign — blank, never zero."
        }
      >
        <div className="flex h-4 items-center justify-end font-mono text-[11px] text-muted-foreground/60">
          —
        </div>
      </td>
    );
  }

  const estimated = row.estimated?.(campaign) ?? false;
  const title = [exactTitle(row, v)];
  if (estimated) {
    title.push(
      row.format === "php" && row.key !== "delivered"
        ? `Measured over only the blocks that are closed and priced. ${coverageSentence(campaign)}`
        : estimateTitle(campaign.fedPriceCoveragePct),
    );
  }

  return (
    <td className="border-l px-2 py-1" title={title.join(" · ")}>
      {row.format === "php" ? (
        <div className="flex h-4 items-baseline justify-between gap-1 font-mono text-[11px] tabular-nums">
          <span className="shrink-0 text-[9.5px] text-muted-foreground">₱</span>
          <span className="flex min-w-0 items-baseline gap-0.5">
            <span className={cn("truncate", row.star && "font-semibold")}>
              {fmt(row, v)}
            </span>
            {estimated && (
              <span
                className="shrink-0 text-[9.5px] leading-none text-muted-foreground"
                aria-label="estimated"
              >
                ~
              </span>
            )}
          </span>
        </div>
      ) : (
        <div className="flex h-4 items-baseline justify-end font-mono text-[11px] tabular-nums">
          <span className={cn("truncate", row.star && "font-semibold")}>
            {fmt(row, v)}
          </span>
          {row.format === "pct" && (
            <span className="ml-px text-[9.5px] text-muted-foreground">%</span>
          )}
        </div>
      )}
    </td>
  );
}

export interface BatchCostPanelProps {
  campaigns: readonly CampaignCost[];
  canViewPrices: boolean;
}

export function BatchCostPanel({ campaigns, canViewPrices }: BatchCostPanelProps) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);

  // Open on the CURRENT campaign. Thirty-two columns start in 2024, and the
  // one anyone came for is the last.
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [campaigns.length]);

  if (campaigns.length === 0) {
    return (
      <section className="rounded-lg border bg-card px-4 py-8 text-center text-xs text-muted-foreground">
        No production campaigns recorded yet.
      </section>
    );
  }

  const minWidth = W_LABEL + campaigns.length * W_CAMPAIGN;

  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold uppercase tracking-wide">
            By production batch
          </h2>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            A campaign is the unit the plant actually runs, and it{" "}
            <strong className="font-medium text-foreground">
              spans calendar months
            </strong>{" "}
            — AUGUST closed and SEPTEMBER opened on the same day. So this
            answers &ldquo;what did AUGUST the campaign cost&rdquo;, which is a
            different and also-true answer from the matrix above.
          </p>
        </div>
        <span className="shrink-0 text-[10.5px] text-muted-foreground">
          {campaigns.length} campaigns · scroll left for older
        </span>
      </header>

      <div ref={scrollerRef} className="overflow-x-auto rounded-lg border bg-card">
        <table
          className="table-fixed text-xs"
          style={{
            width: "max-content",
            minWidth,
            borderCollapse: "separate",
            borderSpacing: 0,
          }}
        >
          <colgroup>
            <col style={{ width: W_LABEL }} />
            {campaigns.map((c) => (
              <col key={c.campaignLabel} style={{ width: W_CAMPAIGN }} />
            ))}
          </colgroup>

          <thead>
            <tr className="h-9 border-b">
              {/* Sticky-left AND opaque — it overlaps scrolling cells. */}
              <th
                scope="col"
                className="frozen-col frozen-edge border-b bg-muted px-2 py-1 text-left text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                Campaign
              </th>
              {campaigns.map((c) => (
                <th
                  key={c.campaignLabel}
                  scope="col"
                  title={`${c.campaignLabel} · ${
                    c.firstFedDate && c.lastFedDate
                      ? `fed ${c.firstFedDate} → ${c.lastFedDate}`
                      : "no feeding recorded yet"
                  } · ${coverageSentence(c)}`}
                  className="border-b border-l bg-muted px-2 py-1 text-right align-bottom"
                >
                  <span className="block truncate text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
                    {c.productionBatch.slice(0, 3)} {c.campaignYear}
                  </span>
                  <span className="block truncate font-mono text-[9px] leading-3 text-muted-foreground/70">
                    {c.lastFedDate ? c.lastFedDate.slice(5) : "not fed"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {ROWS.map((row) => {
              const restricted = row.price && !canViewPrices;
              return (
                <tr
                  key={row.key}
                  className={cn(
                    "group h-8 border-b transition-all duration-150 last:border-0",
                    row.star ? "bg-muted/30" : "hover:bg-muted/20",
                  )}
                >
                  <th
                    scope="row"
                    title={row.title}
                    className={cn(
                      "frozen-col frozen-edge border-b px-2 py-1 text-left align-middle font-normal",
                      // SOLID tokens only — this cell sits ON TOP of scrolling
                      // cells, so any alpha lets them bleed through it.
                      row.star ? "bg-accent" : "bg-card group-hover:bg-muted",
                    )}
                    style={{ left: 0 }}
                  >
                    <span className="flex items-baseline gap-1">
                      {row.star && (
                        <TrendingUp
                          aria-hidden
                          className="size-3 shrink-0 self-center text-muted-foreground"
                        />
                      )}
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block truncate text-[11px] leading-4",
                            row.star ? "font-semibold" : "font-medium",
                          )}
                        >
                          {row.label}
                        </span>
                        <span className="block truncate text-[9.5px] leading-3 text-muted-foreground">
                          {restricted ? "restricted" : row.sublabel}
                        </span>
                      </span>
                    </span>
                  </th>
                  {campaigns.map((c) => (
                    <CampaignCell
                      key={c.campaignLabel}
                      row={row}
                      campaign={c}
                      restricted={restricted}
                    />
                  ))}
                </tr>
              );
            })}

            {/* The coverage line — so a blank true price is explained IN the
                table rather than only in a hover nobody hunts for. */}
            <tr className="h-7 border-t bg-muted/20">
              <th
                scope="row"
                title="A campaign's true cost is only final once every block it fed has been closed and priced. This line says how far along that is."
                className="frozen-col frozen-edge bg-muted px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                Blocks closed / priced
              </th>
              {campaigns.map((c) => (
                <td
                  key={c.campaignLabel}
                  className="border-l px-2 py-1 text-right"
                  title={coverageSentence(c)}
                >
                  <span
                    className={cn(
                      "font-mono text-[10px] tabular-nums",
                      c.isFullyCovered ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {c.blocksFed == null
                      ? "—"
                      : `${c.blocksClosed ?? 0}/${c.blocksFed} · ${c.blocksInPrice ?? 0}`}
                  </span>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-[10.5px] leading-relaxed text-muted-foreground">
        A <span className="font-mono">~</span> marks a figure measured over only
        part of the campaign — either blocks that are not yet closed and priced,
        or kilos fed out of piles with no delivery record at all. A dash is never
        a zero: hover it and it says what is missing.{" "}
        {canViewPrices
          ? "The two ₱ per produced kg rows are the same question asked twice — once at what the charcoal cost on arrival, once at what it cost after the weight it lost."
          : "₱ rows are withheld for your role; nothing was sent to this browser."}
      </p>
    </section>
  );
}
