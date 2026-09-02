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
// cost MORE than the BLOCK PRICE. The gap between the block-price row and the
// true row IS that cost, and the uplift row prints it directly. July 2026:
// ₱46.09 at the block, ₱48.26 by the time it was fed — ₱2.17 a kilo of storage
// time on 4.50% weight loss.
//
// ── OWNER FEEDBACK R1 (2026-09-01) ───────────────────────────────────────────
// "Delivered ₱/kg fed" is now **Block price** here as well as in the matrix —
// Renzo's own words for it, "the price of the charcoal when it arrived at the
// block". The ₱-per-produced row that pairs with it says "block-price basis"
// rather than "arrival basis", and the whole panel moved up a type scale with
// its two column widths re-measured (208 → 232, 116 → 128).
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
import { Lock, Printer, RotateCcw, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { estimateTitle } from "@/lib/analytics/format";
import { SECTION_ACCENT } from "@/lib/analytics/metrics";
import { campaignKey, campaignMonthKeys } from "@/lib/analytics/campaign";
import { applyOrder } from "@/lib/analytics/row-order";
import type { CampaignCost } from "@/lib/analytics/types";
import { PeriodFilter, type PeriodFilterOption } from "./period-filter";
import { UnitValue } from "./unit-value";
import { RowHandle, rowDropProps } from "./row-handle";
import { useRowOrder } from "./use-row-order";
import { printCard } from "./print-card";

// Explicit pixel widths — the sum below IS the table's minWidth.
// R3: CSS variables, so the widths move with the big-screen type scale.
// Big values: 232 -> 276, 128 -> 152.
const W_LABEL = "var(--an-w-name)";
const W_CAMPAIGN = "var(--an-w-campaign)";

type Format = "tonnes" | "php" | "pct" | "count";

/**
 * R6 — the glyph a row pins to the LEFT of every cell.
 *
 * The panel has its own tiny `Format` union rather than the registry's
 * `MetricUnit` (it is not a `MetricSpec` — it has no rollup, no history and no
 * chart), so it maps its own. The VALUES match `format.ts → UNIT_GLYPH`
 * exactly, and the two `count` rows say what they count rather than printing a
 * bare number beside eight rows that all declare a unit.
 */
const FORMAT_GLYPH: Record<Format, string> = {
  tonnes: "T",
  php: "₱/kg",
  pct: "%",
  count: "",
};

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
  /** R6 — overrides `FORMAT_GLYPH` where a bare `count` needs a noun. */
  glyph?: string;
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
    // OWNER FEEDBACK R1 — the same rename as the matrix row it mirrors.
    label: "Block price",
    sublabel: "₱/kg on arrival",
    format: "php",
    decimals: 2,
    price: true,
    value: (c) => c.deliveredPhpKgFed,
    estimated: (c) => c.fedPriceCoveragePct != null && c.fedPriceCoveragePct < 100,
    // ── OWNER FEEDBACK R4 — THE CALENDAR-VS-BATCH ANSWER, RECORDED ──────
    // The matrix used to carry a Block price row of its own, and Renzo asked
    // whether the two were the same number. They are the same FACT on two
    // different clocks: that row measured a calendar month, this one measures
    // the campaign. A campaign is what the plant actually runs and it
    // straddles month boundaries — AUGUST closed and SEPTEMBER opened on
    // 2026-08-29 — so neither was wrong and neither was redundant of the
    // other. The calendar row is retired because the campaign is the clock
    // the question is really asked on, and the sentence below is where that
    // answer lives now, at the point of use.
    title:
      "The price of the charcoal when it arrived at the block, for everything this campaign fed. Weighted over the kilos fed, never the mean of the daily prices. Measured BY BATCH, not by calendar months — a batch can straddle months (AUGUST closed and SEPTEMBER opened on the same day), so this is the same fact the old monthly Money row carried, read on the clock the plant actually runs on.",
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
      "What that charcoal REALLY cost by the time it was fed. The campaign-weighted version is the one to set beside the block price — it is attributed to this campaign's own kilos, so the two are like for like.",
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
      "The gap between the block price and the true price — literally what it cost to let the charcoal sit. The weight shrinks, the money does not, so the same pesos end up spread over fewer kilos.",
    blankTitle: (c) => `${TRUE_PRICE_BLANK} ${coverageSentence(c)}`,
  },
  {
    // ── OWNER FEEDBACK R4 — the matrix's Closed-block loss row lands here ──
    // Same measurement, per campaign instead of per calendar month. It was
    // always the better home: a block closes when its last feeding happens,
    // and which CAMPAIGN was feeding it is a fact about the plant, while
    // which MONTH that fell in is an accident of the calendar.
    key: "loss",
    label: "Weight lost",
    sublabel: "% of delivered kg",
    format: "pct",
    decimals: 2,
    price: false,
    value: (c) => (c.lossPct == null ? null : c.lossPct * 100),
    title:
      "How much weight the blocks this campaign fed lost while they sat, as a share of what was delivered into them. Physical, so it needs no price and uses every block — including ones whose peso figures are missing. It can read slightly negative where a block fed out a little more than was booked in; that is misfiled paperwork, shown as measured rather than clamped to zero.",
  },
  {
    // ── OWNER FEEDBACK R4 — and so does Blocks closed ──────────────────
    // The coverage line at the foot of this table already carried
    // `closed/fed · priced`, but it reads as a footnote about confidence
    // rather than as a figure. Renzo asked for it as a ROW, because "how many
    // piles did this campaign finish off" is a thing he watches, not a caveat.
    // Same numbers, promoted; the coverage line stays, because it is the
    // sentence a blank true price owes its reader.
    key: "blocks_closed",
    label: "Blocks closed",
    sublabel: "piles finished",
    format: "count",
    glyph: "piles",
    decimals: 0,
    price: false,
    value: (c) => c.blocksClosed,
    title:
      "How many of the piles this campaign fed have been finished off and closed out. Nothing in the database dates a status change, so a block's LAST FEEDING stands in for its closing date — the same approximation the RC Movement screen uses, on purpose, so the two cannot disagree about which campaign closed a block.",
    blankTitle: () =>
      "This campaign has not fed anything yet, so no block can have closed on it.",
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
    sublabel: "block-price basis",
    format: "php",
    decimals: 2,
    price: true,
    value: (c) => c.phpPerProducedKgDelivered,
    title:
      "What one kilo of finished product cost in charcoal, at the BLOCK PRICE — what the charcoal cost on arrival. Charcoal only: no labour, power, bags or depreciation.",
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
        <UnitValue
          glyph={row.glyph ?? FORMAT_GLYPH[row.format]}
          className="h-[var(--an-h-5)] font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground/60"
          after={<Lock className="size-2.5 shrink-0" aria-hidden />}
        >
          —
        </UnitValue>
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
        <UnitValue
          glyph={row.glyph ?? FORMAT_GLYPH[row.format]}
          className="h-[var(--an-h-5)] font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground/60"
        >
          —
        </UnitValue>
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
      {/* R6 — the accounting format, for every unit and not only ₱. */}
      <UnitValue
        glyph={row.glyph ?? FORMAT_GLYPH[row.format]}
        className="h-[var(--an-h-5)] font-mono text-[length:var(--bw-fs-13)] tabular-nums"
        valueClassName={row.star ? "font-semibold" : undefined}
        after={
          estimated ? (
            <span
              className="shrink-0 text-[length:var(--bw-fs-11)] leading-none text-muted-foreground"
              aria-label="estimated"
            >
              ~
            </span>
          ) : undefined
        }
      >
        {fmt(row, v)}
      </UnitValue>
    </td>
  );
}

export interface BatchCostPanelProps {
  /** EVERY campaign, in chronological order — the checklist lists them all. */
  campaigns: readonly CampaignCost[];
  canViewPrices: boolean;
  /**
   * R5 — the switched-OFF campaign keys. Owned by the page shell, because the
   * same selection also decides which months the production band covers.
   */
  hidden: ReadonlySet<string>;
  onHiddenChange(next: Set<string>): void;
}

export function BatchCostPanel({
  campaigns,
  canViewPrices,
  hidden,
  onHiddenChange,
}: BatchCostPanelProps) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const sectionRef = React.useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = React.useState<string | null>(null);

  /**
   * ── R5 — THE BATCH CHECKLIST ──────────────────────────────────────────
   * Renzo: *"this group sorely lacks what RC Inventory has in terms of data
   * filtering."*
   *
   * The options are `campaigns` in PAYLOAD ORDER, and that is the whole
   * sorting story: the adapter already orders campaigns chronologically by the
   * month their NAME spells (`campaignSeq`, now in `lib/analytics/campaign.ts`
   * so this file and the server share one definition). So the checklist reads
   * JAN → DEC within each year, matching the columns beside it exactly, and
   * nothing here re-derives an order that could disagree with them. An
   * alphabetical list — APRIL, AUGUST, DECEMBER — would have been the obvious
   * bug and is unrepresentable here.
   */
  const options = React.useMemo<PeriodFilterOption[]>(
    () =>
      campaigns.map((c) => {
        const months = campaignMonthKeys(c);
        return {
          key: campaignKey(c),
          label: c.campaignLabel,
          meta: c.lastFedDate ? c.lastFedDate.slice(5) : "not fed",
          empty: c.fedKg == null,
          title:
            `${c.campaignLabel} — ${
              c.firstFedDate && c.lastFedDate
                ? `fed ${c.firstFedDate} → ${c.lastFedDate}`
                : "no feeding recorded yet"
            }. Covers ${months.length} calendar month${months.length === 1 ? "" : "s"}` +
            `${months.length ? ` (${months.join(", ")})` : ""} — unticking it also removes those months from the production band below, unless another selected batch runs in them.`,
        };
      }),
    [campaigns],
  );

  const shownCampaigns = React.useMemo(
    () =>
      hidden.size === 0
        ? campaigns
        : campaigns.filter((c) => !hidden.has(campaignKey(c))),
    [campaigns, hidden],
  );

  /** R5 — the reader's own row order for this group. */
  const defaultKeys = React.useMemo(() => ROWS.map((r) => r.key), []);
  const rowOrder = useRowOrder("campaign", defaultKeys);
  const rows = React.useMemo(
    () => applyOrder(ROWS, rowOrder.order, (r) => r.key),
    [rowOrder.order],
  );

  const onDrop = React.useCallback(
    (key: string, target: string) => {
      rowOrder.drop(key, target);
      setDragging(null);
    },
    [rowOrder],
  );

  // Open on the CURRENT campaign. Thirty-two columns start in 2024, and the
  // one anyone came for is the last.
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [shownCampaigns.length]);

  if (campaigns.length === 0) {
    return (
      <section className="rounded-lg border bg-card px-4 py-8 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
        No production campaigns recorded yet.
      </section>
    );
  }

  const minWidth = `calc(${W_LABEL} + ${shownCampaigns.length} * ${W_CAMPAIGN})`;

  return (
    <section ref={sectionRef} className="flex flex-col gap-2">
      <header
        className="bw-accent-rule flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pl-2.5"
        style={{ "--bw-accent": SECTION_ACCENT.campaigns } as React.CSSProperties}
      >
        <div className="min-w-0">
          <h2
            className="text-[length:var(--bw-fs-13)] font-semibold uppercase tracking-wide"
            style={{ color: SECTION_ACCENT.campaigns }}
          >
            By production batch
          </h2>
          <p className="text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
            A campaign is the unit the plant actually runs, and it{" "}
            <strong className="font-medium text-foreground">
              spans calendar months
            </strong>{" "}
            — AUGUST closed and SEPTEMBER opened on the same day. So this
            answers &ldquo;what did AUGUST the campaign cost&rdquo;, and since
            owner feedback R4 it is the{" "}
            <strong className="font-medium text-foreground">only</strong> place
            that question is answered: the matrix&rsquo;s calendar-month money
            rows were the same facts on the wrong clock, so they were retired
            and blocks closed and weight lost moved here.
          </p>
        </div>
        {/* ── R5 — the group's own controls ────────────────────────────── */}
        <span
          className="flex shrink-0 flex-wrap items-center justify-end gap-1.5"
          data-print-hide
        >
          <span className="text-[length:var(--bw-fs-115)] text-muted-foreground">
            {hidden.size > 0
              ? `${shownCampaigns.length} of ${campaigns.length} batches`
              : `${campaigns.length} campaigns · scroll left for older`}
          </span>
          <PeriodFilter
            label="Batches"
            noun="batch"
            nounPlural="batches"
            align="end"
            options={options}
            hidden={hidden}
            onChange={onHiddenChange}
            title="Choose which production batches this panel shows. Everything is on by default and the list is in the batches' own chronological order — January to December within each year, taken from the month each batch is NAMED for, never alphabetically. Unticking a batch ALSO narrows the production band below to the calendar months the remaining batches ran in."
          />
          {rowOrder.custom && (
            <button
              type="button"
              onClick={rowOrder.reset}
              title="Put these rows back in their original order. The order is remembered in this browser only and never changed a figure."
              className="inline-flex h-[var(--an-h-8)] cursor-pointer items-center gap-1 rounded-md border border-border/60 bg-background px-2 text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw className="size-3" aria-hidden />
              Reset order
            </button>
          )}
          {/* This panel has no per-column detail card, so its group print is
              the TABLE itself — the same landscape sheet, carrying the thing
              the panel actually is. `printCard` marks the section for the
              duration and unmarks it afterwards (R5), so nothing on this page
              wears `data-print-card` permanently except the two expands. */}
          <button
            type="button"
            onClick={() => printCard(sectionRef.current)}
            title="Print this panel as one landscape sheet — the batch columns as shown, in the row order you set."
            className="inline-flex h-[var(--an-h-8)] cursor-pointer items-center gap-1 rounded-md border border-border/60 bg-background px-2 text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Printer className="size-3" aria-hidden />
            Print
          </button>
        </span>
      </header>

      {/* TWO different facts, never one sentence. "No campaigns recorded" is
          about the data; "every batch is switched off" is a state the reader
          created a second ago and can undo — the same split the matrix's own
          empty state makes. */}
      {shownCampaigns.length === 0 ? (
        <div className="rounded-lg border bg-card px-4 py-8 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
          Every batch is switched off. Open the Batches filter above and turn
          one back on — all {campaigns.length} are still there. The production
          band below follows this selection, so it is empty too until one comes
          back.
        </div>
      ) : (
      <div ref={scrollerRef} className="overflow-x-auto rounded-lg border bg-card">
        <table
          className="table-fixed text-[length:var(--bw-fs-14)] leading-[var(--bw-lh-sm)]"
          style={{
            width: "max-content",
            minWidth,
            borderCollapse: "separate",
            borderSpacing: 0,
          }}
        >
          <colgroup>
            <col style={{ width: W_LABEL }} />
            {shownCampaigns.map((c) => (
              <col key={c.campaignLabel} style={{ width: W_CAMPAIGN }} />
            ))}
          </colgroup>

          <thead>
            <tr className="h-[var(--an-h-9)] border-b">
              {/* Sticky-left AND opaque — it overlaps scrolling cells. */}
              <th
                scope="col"
                className="frozen-col frozen-edge border-b bg-muted px-2 py-1 text-left text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                Campaign
              </th>
              {shownCampaigns.map((c) => (
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
                  <span className="block truncate text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground">
                    {c.productionBatch.slice(0, 3)} {c.campaignYear}
                  </span>
                  <span className="block truncate font-mono text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-3)] text-muted-foreground/70">
                    {c.lastFedDate ? c.lastFedDate.slice(5) : "not fed"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((row, i) => {
              const restricted = row.price && !canViewPrices;
              const isDragging = dragging === row.key;
              return (
                <tr
                  key={row.key}
                  {...rowDropProps(row.key, dragging, onDrop)}
                  className={cn(
                    // R5 — the divider Renzo asked for, carried by the opaque
                    // frozen label cell as solidly as by a scrolling one.
                    "group bw-row-rule h-[var(--an-h-10)] transition-all duration-150",
                    row.star ? "bg-muted/30" : "hover:bg-muted/20",
                    isDragging && "opacity-40",
                    dragging && !isDragging && "hover:bg-accent/60",
                  )}
                >
                  <th
                    scope="row"
                    title={row.title}
                    className={cn(
                      "frozen-col frozen-edge px-2 py-1 text-left align-middle font-normal",
                      // SOLID tokens only — this cell sits ON TOP of scrolling
                      // cells, so any alpha lets them bleed through it.
                      row.star ? "bg-accent" : "bg-card group-hover:bg-muted",
                    )}
                    style={{ left: 0 }}
                  >
                    <span className="flex items-baseline gap-1">
                      <RowHandle
                        rowKey={row.key}
                        label={row.label}
                        position={i + 1}
                        total={rows.length}
                        onMove={rowOrder.move}
                        onDragStart={setDragging}
                        onDragEnd={() => setDragging(null)}
                        className="self-center"
                      />
                      {row.star && (
                        <TrendingUp
                          aria-hidden
                          className="size-3 shrink-0 self-center text-muted-foreground"
                        />
                      )}
                      <span className="min-w-0">
                        <span
                          className={cn(
                            "block truncate text-[length:var(--bw-fs-125)] leading-[var(--bw-lh-4)]",
                            row.star ? "font-semibold" : "font-medium",
                          )}
                        >
                          {row.label}
                        </span>
                        <span className="block truncate text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground">
                          {restricted ? "restricted" : row.sublabel}
                        </span>
                      </span>
                    </span>
                  </th>
                  {shownCampaigns.map((c) => (
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
            <tr className="h-[var(--an-h-7)] border-t bg-muted/20">
              <th
                scope="row"
                title="A campaign's true cost is only final once every block it fed has been closed and priced. This line says how far along that is."
                className="frozen-col frozen-edge bg-muted px-2 py-1 text-left text-[length:var(--bw-fs-11)] font-medium uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                Blocks closed / priced
              </th>
              {shownCampaigns.map((c) => (
                <td
                  key={c.campaignLabel}
                  className="border-l px-2 py-1 text-right"
                  title={coverageSentence(c)}
                >
                  <span
                    className={cn(
                      "font-mono text-[length:var(--bw-fs-11)] tabular-nums",
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
      )}

      <p className="text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
        A <span className="font-mono">~</span> marks a figure measured over only
        part of the campaign — either blocks that are not yet closed and priced,
        or kilos fed out of piles with no delivery record at all. A dash is never
        a zero: hover it and it says what is missing.{" "}
        {canViewPrices
          ? "The two ₱ per produced kg rows are the same question asked twice — once at the block price, once at what the charcoal cost after the weight it lost."
          : "₱ rows are withheld for your role; nothing was sent to this browser."}
      </p>
    </section>
  );
}
