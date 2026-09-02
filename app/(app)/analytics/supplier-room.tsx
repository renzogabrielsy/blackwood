"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE SUPPLIER ROOM (P3) — who we bought from, and on what terms.
//
// ── WHY IT IS A SECTION BELOW THE CAMPAIGN PANEL, NOT A TAB ──────────────────
// The page reads as one descending axis: PERIOD (the KPI matrix) → CAMPAIGN
// (the batch panel) → SUPPLIER (here) → PRODUCTION (below). Each block
// re-cuts the same yard by a different key, and putting the supplier room
// behind a tab would hide it from exactly the reader who has just seen the
// purchase-volume row move and wants to know WHO moved it. The room is also
// self-limiting — twelve rows of a matrix, a chart and a ranked list — so it
// costs about as much page as the campaign panel already does.
//
// ── THE HEADER IS A MAGNITUDE, NEVER A VERDICT ───────────────────────────────
// Top-1 and top-3 share are printed as plain chips with no colour and no
// threshold. Ornales is 45.5% of 2026 and the top three are 85.1%, which is
// materially more concentrated than the plan's ~40% assumption — but the plan
// withholds threshold colouring until Renzo states real targets, so the page
// states the number and stops. §0a.5.
//
// Everything below reads ONE payload slice and one already-loaded monthly
// series; nothing here fetches, and nothing here re-derives a figure the SQL
// layer owns.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Users } from "lucide-react";
import { SECTION_ACCENT } from "@/lib/analytics/metrics";
import type { AnalyticsMonth, SupplierData } from "@/lib/analytics/types";
import {
  buildExplorer,
  buildSupplierYear,
  SUPPLIER_DICTIONARY,
} from "@/lib/analytics/supplier";
import { DictionaryPopover } from "./metric-info";
import { SupplierMatrix } from "./supplier-matrix";
import { SupplierPremium } from "./supplier-premium";
import { SupplierExplorer } from "./supplier-explorer";
import { SupplierExpand } from "./supplier-expand";

function pct1(v: number | null): string {
  if (v == null) return "—";
  return `${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function t1(kg: number): string {
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/** One concentration chip. No colour, no threshold — a magnitude and a name. */
function Chip({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  title?: string;
}) {
  return (
    <div
      className="min-w-0 rounded-md border bg-background/40 px-2.5 py-1.5"
      title={title}
    >
      <div className="truncate text-[length:var(--bw-fs-105)] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="truncate font-mono text-[length:var(--bw-fs-15)] font-semibold tabular-nums">
          {value}
        </span>
        {sub && (
          <span className="truncate text-[length:var(--bw-fs-11)] text-muted-foreground">{sub}</span>
        )}
      </div>
    </div>
  );
}

export interface SupplierRoomProps {
  suppliers: SupplierData;
  /** P1's own monthly series — the explorer's three lines, already loaded. */
  months: readonly AnalyticsMonth[];
  /** The year the page's own picker is on. The room follows it. */
  year: number;
  canViewPrices: boolean;
  /**
   * R4 — the page's master `Definitions` switch and the print stamps, passed
   * straight through to the supplier expand.
   *
   * This room mounts its OWN expand card (a supplier's panel has to open under
   * the supplier matrix, not under the KPI matrix at the top), so the page's
   * controls have to reach it here — otherwise one of the page's three expands
   * would ignore a switch the other two obey, which is exactly the
   * inconsistency the universal module contract exists to close.
   */
  showDictionary: boolean;
  printScope: string;
  asOfDate: string | null;
}

export function SupplierRoom({
  suppliers,
  months,
  year,
  canViewPrices,
  showDictionary,
  printScope,
  asOfDate,
}: SupplierRoomProps) {
  const [selected, setSelected] = React.useState<string | null>(null);

  const data = React.useMemo(
    () => buildSupplierYear(suppliers.rows, year),
    [suppliers.rows, year],
  );
  const explorer = React.useMemo(
    () => buildExplorer(months, year),
    [months, year],
  );

  // A supplier selected in one year need not exist in the next.
  const expanded = selected
    ? (data.rows.find((r) => r.supplier === selected) ?? null)
    : null;
  React.useEffect(() => {
    if (selected && !data.rows.some((r) => r.supplier === selected)) {
      setSelected(null);
    }
  }, [selected, data.rows]);

  const c = data.concentration;

  return (
    <section className="flex flex-col gap-3">
      <header
        className="bw-accent-rule flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 pl-2.5"
        style={{ "--bw-accent": SECTION_ACCENT.suppliers } as React.CSSProperties}
      >
        <div className="min-w-0">
          <h2
            className="text-[length:var(--bw-fs-13)] font-semibold uppercase tracking-wide"
            style={{ color: SECTION_ACCENT.suppliers }}
          >
            Suppliers
          </h2>
          <p className="text-[length:var(--bw-fs-12)] leading-relaxed text-muted-foreground">
            Who we actually bought from in {data.year}, what share of the yard
            each one is, and whether we paid them above or below the going rate.
            Sun-drying returns and re-cooks are never counted as a purchase —
            we already paid for those kilos once.
          </p>
        </div>
        <span className="shrink-0 text-[length:var(--bw-fs-115)] text-muted-foreground">
          {data.totalDeliveries.toLocaleString("en-US")} truckloads ·{" "}
          <span className="font-mono">{t1(data.totalKg)}</span> t
        </span>
      </header>

      {/* ── Concentration ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-card p-2 sm:grid-cols-4">
        <Chip
          label="Suppliers"
          value={String(c.supplierCount)}
          sub={data.rows.length > c.supplierCount ? "+ returns only" : undefined}
          title={`How many different sellers delivered to us in ${data.year}. A supplier is the canonical name, so the spelling variants of one seller count once. Names whose only movement was returning sun-dried material are not counted as sellers.`}
        />
        <Chip
          label="Top supplier"
          value={pct1(c.top1Pct)}
          sub={c.top1Name ?? undefined}
          title={`${c.top1Name ?? "—"} supplied ${pct1(c.top1Pct)} of everything bought in ${data.year}. A magnitude, not a verdict — nothing on this page turns amber because a share is high.`}
        />
        <Chip
          label="Top 3"
          value={pct1(c.top3Pct)}
          sub={c.top3Names.join(" · ") || undefined}
          title={`The three biggest sellers together supplied ${pct1(c.top3Pct)} of ${data.year}: ${c.top3Names.join(", ") || "—"}.`}
        />
        <Chip
          label="Half the yard"
          value={c.suppliersToHalf == null ? "—" : String(c.suppliersToHalf)}
          sub={
            c.suppliersToHalf == null
              ? undefined
              : c.suppliersToHalf === 1
                ? "supplier"
                : "suppliers"
          }
          title={`How many of the biggest sellers it takes, added together, to reach half the year's kilos.`}
        />
      </div>

      <div className="-mt-1 flex items-center gap-1 text-[length:var(--bw-fs-115)] text-muted-foreground">
        <Users className="size-3 shrink-0" aria-hidden />
        <span>Concentration is dependency, measured — no thresholds applied.</span>
        <DictionaryPopover
          label={SUPPLIER_DICTIONARY.concentration.label}
          sublabel={SUPPLIER_DICTIONARY.concentration.sublabel}
          entry={SUPPLIER_DICTIONARY.concentration.dictionary}
        />
        <span className="ml-2 hidden items-center gap-1 sm:inline-flex">
          Share of the month
          <DictionaryPopover
            label={SUPPLIER_DICTIONARY.share_of_month.label}
            sublabel={SUPPLIER_DICTIONARY.share_of_month.sublabel}
            entry={SUPPLIER_DICTIONARY.share_of_month.dictionary}
          />
        </span>
        <span className="ml-2 hidden items-center gap-1 sm:inline-flex">
          Returned from sundry
          <DictionaryPopover
            label={SUPPLIER_DICTIONARY.sundry_returns.label}
            sublabel={SUPPLIER_DICTIONARY.sundry_returns.sublabel}
            entry={SUPPLIER_DICTIONARY.sundry_returns.dictionary}
          />
        </span>
      </div>

      {/* ── The matrix, with the expanded supplier directly beneath it ── */}
      <SupplierMatrix data={data} selected={selected} onSelect={setSelected}>
        {expanded && (
          <SupplierExpand
            // Keyed by supplier AND year — a fresh, smart-defaulted month
            // filter per card, the same discipline the KPI expand's key gives
            // its year filter. A selection made about one seller must never
            // silently apply to the next one opened.
            key={`${expanded.supplier}:${data.year}`}
            row={expanded}
            data={data}
            canViewPrices={canViewPrices}
            showDictionary={showDictionary}
            scopeLabel={printScope}
            asOfDate={asOfDate}
            onClose={() => setSelected(null)}
          />
        )}
      </SupplierMatrix>

      {/* ── The money read, and the three-line story ───────────────────── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <SupplierPremium data={data} canViewPrices={canViewPrices} />
        <SupplierExplorer
          points={explorer}
          canViewPrices={canViewPrices}
          year={data.year}
        />
      </div>

      {/* ── THE "A CELL IS TONNES BOUGHT…" BLOCK IS GONE (owner feedback R5)
          Renzo's screenshots marked it for removal. Everything it said is
          still on screen where it is needed: the `Supplier` header carries the
          dictionary popover with the full definition, every cell's own hover
          reads "X t — Y% of everything bought that month", the `·` cell's
          hover says "did nothing at all this month", and the `Σ market` row's
          own hover states that it is the matrix's published Purchase volume
          figure rather than a sum of the rows.

          The TRUNCATION warning survives, because it is not documentation —
          it is a fact about THIS read, it appears nowhere else, and a supplier
          list that is quietly short of the real one is exactly the thing a
          reader must be told about. */}
      {suppliers.truncated && (
        <p className="text-[length:var(--bw-fs-115)] leading-relaxed text-muted-foreground">
          This read came back at the database row limit, so the supplier set may
          be short of the full one.
        </p>
      )}
    </section>
  );
}
