"use client";

// ─────────────────────────────────────────────────────────────────────────────
// THE SUPPLIER × MONTH VOLUME MATRIX — who sold us what, month by month.
//
// Same bespoke-table discipline as the KPI matrix above it, and for the same
// reasons (the formatter belongs to the table, not the column; nothing here is
// ever edited; the row expand is a chart and would be as wide as the scrolling
// table if it lived inside a `table-fixed` row). Both platform layout rules are
// obeyed:
//
//   • **"Never crush, always scroll"** — `table-fixed`, `width: max-content`, a
//     full `<colgroup>` of explicit pixel widths, wrapped in `overflow-x-auto`.
//     No flexible column; the flexible one is the one that silently crushes.
//   • **Frozen panes are OPAQUE** — the supplier-name column is sticky-left
//     over scrolling cells, so it paints a SOLID token (never `/opacity`, never
//     a backdrop-blur) and repaints its hover/selected tint solidly;
//     `.frozen-edge` kills the seam.
//
// ── THREE THINGS THIS TABLE REFUSES TO DO ────────────────────────────────────
//
// 1. **It never adds returned material to what a supplier sold.** Sun-dried
//    charcoal coming back carries its origin supplier's name, but we already
//    bought those kilos once. It rides as a separate ↩ chip and enters no
//    total, no share and no ranking.
// 2. **A returns-only supplier is ALWAYS on screen**, below the ranked
//    sellers, even when the list is collapsed to the top twelve. SEVILLA
//    bought nothing in 2026 and had 140.6 t come back; a purchase-only view
//    would have rendered that as absence, which is the one thing the
//    `sundry_origin_kg` column exists to prevent.
// 3. **The `Σ market` footer is not a sum of the rows.** It prints the monthly
//    analytics view's own published market kilos, carried onto every supplier
//    row by the view's join — so the footer IS the KPI matrix's Purchase
//    volume row rather than a second number that happens to agree with it.
//    (Measured: 0 mismatches across all 49 months, max gap 0.00 kg.)
//
// The footer row is a plain last row, not a sticky `<tfoot>`: this table never
// scrolls vertically inside its own box, so there is nothing to pin against —
// the same reason the KPI matrix's header is deliberately not sticky-top. Its
// label cell is still sticky-LEFT, because the table scrolls sideways.
//
// ── OWNER FEEDBACK R1 (2026-09-01) ───────────────────────────────────────────
// The supplier expand now opens IN PLACE, in a full-width row directly beneath
// the supplier that was clicked, exactly as the KPI matrix's does — the panel
// inside the spanning cell is `sticky left-0` at the scroller's MEASURED width,
// so it stays in the visible frame while the months scroll under it. And the
// whole table moved up a type scale (cells 11 → 12 px, labels 11 → 12.5 px)
// with every column width re-measured against the new metrics rather than left
// to clip.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { ChevronRight, CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  SupplierCell,
  SupplierRow,
  SupplierYear,
} from "@/lib/analytics/supplier";
import { SUPPLIER_DICTIONARY, SUPPLIER_TOP_N } from "@/lib/analytics/supplier";
import { DictionaryPopover } from "./metric-info";

// Explicit pixel widths — the sum below IS the table's minWidth.
// R3: CSS variables, so the widths move with the big-screen type scale.
// Big values: 196 -> 234, 92 -> 110, 124 -> 148.
const W_SUPPLIER = "var(--an-w-supplier)";
const W_MONTH = "var(--an-w-month)";
const W_TOTAL = "var(--an-w-month-total)";

function t1(kg: number | null): string {
  if (kg == null) return "—";
  return (kg / 1000).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function pct1(v: number | null): string {
  if (v == null) return "";
  return `${v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function kgExact(kg: number): string {
  return `${kg.toLocaleString("en-US", { maximumFractionDigits: 0 })} kg`;
}

/** The hover a purchase cell owes: the exact kilos, the rank, the coverage. */
function cellTitle(supplier: string, cell: SupplierCell): string {
  const parts = [`${supplier} · ${cell.fullLabel}`];
  if (cell.kg != null) {
    parts.push(`${kgExact(cell.kg)} bought`);
    if (cell.sharePct != null) parts.push(`${pct1(cell.sharePct)} of the month`);
    if (cell.rank != null) parts.push(`ranked #${cell.rank} that month`);
    if (cell.deliveryCount != null)
      parts.push(`${cell.deliveryCount} truckload${cell.deliveryCount === 1 ? "" : "s"}`);
    if (cell.avgPrice != null)
      parts.push(`₱${cell.avgPrice.toFixed(2)}/kg paid`);
    if (cell.premium != null)
      parts.push(
        `${cell.premium >= 0 ? "+" : "−"}₱${Math.abs(cell.premium).toFixed(2)}/kg vs the month's market price`,
      );
  } else {
    parts.push("Nothing bought from them this month.");
  }
  if (cell.sundryKg != null) {
    parts.push(
      `↩ ${t1(cell.sundryKg)} t of their material came back from sun-drying — traceability only, never counted as a purchase.`,
    );
  }
  return parts.join(" · ");
}

function ValueCell({
  supplier,
  cell,
  emphasis,
}: {
  supplier: string;
  cell: SupplierCell | null;
  emphasis?: boolean;
}) {
  if (!cell) {
    return (
      <td
        className={cn("border-l px-2 py-1", emphasis && "bg-muted/40")}
        title={`${supplier} did nothing at all this month — no purchase and no returning material.`}
      >
        <div className="flex h-[var(--an-h-30)] items-center justify-end font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground/50">
          ·
        </div>
      </td>
    );
  }

  const returnsOnly = cell.kg == null && cell.sundryKg != null;

  return (
    <td
      className={cn("border-l px-2 py-1", emphasis && "bg-muted/40")}
      title={cellTitle(supplier, cell)}
    >
      <div className="flex h-[var(--an-h-30)] flex-col items-end justify-center">
        {returnsOnly ? (
          // A returns-only month prints the RETURNED tonnage, in the muted
          // returns treatment, so it can never be mistaken for a purchase.
          <span className="flex items-center gap-0.5 font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-4)] text-muted-foreground tabular-nums">
            <CornerDownLeft className="size-2.5 shrink-0" aria-hidden />
            {t1(cell.sundryKg)}
          </span>
        ) : (
          <>
            <span className="truncate font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-4)] tabular-nums">
              {t1(cell.kg)}
              {cell.sundryKg != null && (
                <CornerDownLeft
                  aria-label="also had material return from sun-drying"
                  className="ml-0.5 inline size-2.5 align-baseline text-muted-foreground"
                />
              )}
            </span>
            <span className="truncate font-mono text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground tabular-nums">
              {pct1(cell.sharePct) || " "}
            </span>
          </>
        )}
      </div>
    </td>
  );
}

function SupplierRowView({
  row,
  months,
  selected,
  onSelect,
}: {
  row: SupplierRow;
  months: SupplierYear["months"];
  selected: boolean;
  onSelect(supplier: string | null): void;
}) {
  return (
    <tr
      className={cn(
        "group h-[var(--an-h-48)] border-b transition-all duration-150",
        selected ? "bg-muted/50" : "hover:bg-muted/30",
      )}
    >
      <th
        scope="row"
        className={cn(
          // SOLID token only — this cell sits ON TOP of scrolling cells.
          "frozen-col frozen-edge border-b px-2 py-1 text-left align-middle font-normal",
          selected ? "bg-accent" : "bg-card group-hover:bg-muted",
        )}
        style={{ left: 0 }}
      >
        <button
          type="button"
          onClick={() => onSelect(selected ? null : row.supplier)}
          aria-expanded={selected}
          title={
            row.returnsOnly
              ? `${row.supplier} bought us nothing this year. ${t1(row.sundryKg)} t of their material came back from sun-drying — that is where the name comes from, not a sale.`
              : `${row.supplier} · #${row.rank} by volume · ${kgExact(row.kg)} across ${row.activeMonths} month${row.activeMonths === 1 ? "" : "s"}`
          }
          className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
              selected && "rotate-90 text-foreground",
            )}
          />
          <span className="w-[20px] shrink-0 text-right font-mono text-[length:var(--bw-fs-105)] text-muted-foreground tabular-nums">
            {row.rank ?? "·"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[length:var(--bw-fs-125)] font-medium leading-[var(--bw-lh-4)]">
              {row.supplier}
            </span>
            <span className="flex items-center gap-1">
              <span className="truncate text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground">
                {row.returnsOnly
                  ? "returns only"
                  : `${row.activeMonths} month${row.activeMonths === 1 ? "" : "s"} active`}
              </span>
              {row.sundryKg > 0 && (
                <span
                  title={`+${t1(row.sundryKg)} t returned from sundry across ${row.sundryDeliveries} deliver${row.sundryDeliveries === 1 ? "y" : "ies"} — our own charcoal coming back after sun-drying. It is never added to what they sold us.`}
                  className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border/70 px-1 font-mono text-[length:var(--bw-fs-9)] leading-[var(--bw-lh-13)] text-muted-foreground"
                >
                  <CornerDownLeft className="size-2" aria-hidden />
                  {t1(row.sundryKg)}t
                </span>
              )}
            </span>
          </span>
        </button>
      </th>

      {months.map((m, i) => (
        <ValueCell key={m.monthStart} supplier={row.supplier} cell={row.cells[i]} />
      ))}

      {/* YTD — a plain sum of the months, plus the weighted year share. */}
      <td
        className="border-l bg-muted/40 px-2 py-1"
        title={
          row.returnsOnly
            ? `Nothing bought all year. ${t1(row.sundryKg)} t returned from sun-drying.`
            : `${kgExact(row.kg)} across the year · ${pct1(row.sharePct)} of everything bought · running total to here ${pct1(row.cumulativeSharePct)}`
        }
      >
        <div className="flex h-[var(--an-h-30)] flex-col items-end justify-center">
          <span className="truncate font-mono text-[length:var(--bw-fs-12)] font-semibold leading-[var(--bw-lh-4)] tabular-nums">
            {row.returnsOnly ? "—" : t1(row.kg)}
          </span>
          <span className="truncate font-mono text-[length:var(--bw-fs-105)] leading-[var(--bw-lh-4)] text-muted-foreground tabular-nums">
            {pct1(row.sharePct) || " "}
          </span>
        </div>
      </td>
    </tr>
  );
}

export interface SupplierMatrixProps {
  data: SupplierYear;
  selected: string | null;
  onSelect(supplier: string | null): void;
  /**
   * The expand panel, rendered as a full-width row DIRECTLY beneath the
   * supplier that was clicked (owner feedback R1). It used to sit under the
   * whole table.
   */
  children?: React.ReactNode;
}

export function SupplierMatrix({
  data,
  selected,
  onSelect,
  children,
}: SupplierMatrixProps) {
  const [showAll, setShowAll] = React.useState(false);

  /**
   * The VISIBLE width of the scroller, for the in-place expand — measured,
   * never assumed, and clamped to the table's own width so a table narrower
   * than the viewport cannot be pushed into horizontal overflow by its own
   * expand. Same mechanism as the KPI matrix; see its header comment.
   */
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const [frameWidth, setFrameWidth] = React.useState<number | null>(null);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // A NON-POSITIVE measurement is treated as "not measured yet" and leaves
    // the panel at 100% of its cell. Measured: an observer callback can land
    // while the element has no layout at all (a hidden pane, a reload mid-
    // paint) and reported 0, which pinned the expand to zero width.
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setFrameWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sellers = data.rows.filter((r) => !r.returnsOnly);
  const returnsOnly = data.rows.filter((r) => r.returnsOnly);
  // Returns-only rows are NOT subject to the cap — see the header, rule 2.
  const shown = showAll
    ? [...sellers, ...returnsOnly]
    : [...sellers.slice(0, SUPPLIER_TOP_N), ...returnsOnly];
  const hidden = sellers.length - Math.min(sellers.length, SUPPLIER_TOP_N);

  if (data.months.length === 0) {
    return (
      <div className="rounded-lg border bg-card px-4 py-8 text-center text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground">
        Nothing was bought in {data.year}.
      </div>
    );
  }

  const minWidth = `calc(${W_SUPPLIER} + ${data.months.length} * ${W_MONTH} + ${W_TOTAL})`;
  // Same CSS `min()` clamp as the KPI matrix — see the note there.
  const panelWidth =
    frameWidth == null ? undefined : `min(${frameWidth}px, ${minWidth})`;
  const colCount = data.months.length + 2;

  return (
    <div className="flex flex-col gap-2">
      <div ref={scrollerRef} className="overflow-x-auto rounded-lg border bg-card">
        <table
          className="table-fixed text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)]"
          style={{
            width: "max-content",
            minWidth,
            borderCollapse: "separate",
            borderSpacing: 0,
          }}
        >
          <colgroup>
            <col style={{ width: W_SUPPLIER }} />
            {data.months.map((m) => (
              <col key={m.monthStart} style={{ width: W_MONTH }} />
            ))}
            <col style={{ width: W_TOTAL }} />
          </colgroup>

          <thead>
            <tr className="h-[var(--an-h-9)] border-b">
              <th
                scope="col"
                className="frozen-col frozen-edge border-b bg-muted px-2 py-1 text-left align-bottom text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                <span className="flex items-center gap-1">
                  Supplier
                  <DictionaryPopover
                    label={SUPPLIER_DICTIONARY.supplier_volume.label}
                    sublabel={SUPPLIER_DICTIONARY.supplier_volume.sublabel}
                    entry={SUPPLIER_DICTIONARY.supplier_volume.dictionary}
                  />
                </span>
              </th>
              {data.months.map((m) => (
                <th
                  key={m.monthStart}
                  scope="col"
                  title={`${m.fullLabel} · ${m.marketKg == null ? "no purchases" : kgExact(m.marketKg)} bought from ${m.supplierCount} supplier${m.supplierCount === 1 ? "" : "s"}`}
                  className="border-b border-l bg-muted px-2 py-1 text-right align-bottom"
                >
                  <span className="block truncate text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground">
                    {m.label}
                  </span>
                  <span className="block truncate font-mono text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-3)] text-muted-foreground/70">
                    {m.supplierCount} sellers
                  </span>
                </th>
              ))}
              <th
                scope="col"
                title={`Everything bought in ${data.year}, and each supplier's share of it. The year figure is the sum of the months and the share is that sum over the year's market kilos — never an average of monthly percentages.`}
                className="border-b border-l bg-muted px-2 py-1 text-right align-bottom"
              >
                <span className="block truncate text-[length:var(--bw-fs-115)] font-medium uppercase tracking-wide text-muted-foreground">
                  {data.year}
                </span>
                <span className="block truncate font-mono text-[length:var(--bw-fs-10)] leading-[var(--bw-lh-3)] text-muted-foreground/70">
                  tonnes · share
                </span>
              </th>
            </tr>
          </thead>

          <tbody>
            {shown.map((row) => (
              <React.Fragment key={row.supplier}>
                <SupplierRowView
                  row={row}
                  months={data.months}
                  selected={selected === row.supplier}
                  onSelect={onSelect}
                />
                {/* The expand, IN PLACE — pinned to the visible frame so it
                    does not drift sideways when the months are scrolled. */}
                {children && selected === row.supplier && (
                  <tr className="border-b">
                    <td colSpan={colCount} className="p-0 align-top">
                      <div
                        className="sticky left-0 p-2"
                        style={{ width: panelWidth ?? "100%" }}
                      >
                        {children}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}

            {/* ── Σ market — P1's OWN figure, not a sum of the column ────── */}
            <tr className="h-[var(--an-h-9)] border-t bg-muted/30">
              <th
                scope="row"
                title="Everything the plant bought that month, as the monthly matrix publishes it. This row is not added up from the suppliers above — it is the same figure the Purchase volume row shows, carried through the view's own join, so the two can never drift apart."
                className="frozen-col frozen-edge bg-muted px-2 py-1 text-left text-[length:var(--bw-fs-11)] font-semibold uppercase tracking-wide text-muted-foreground"
                style={{ left: 0 }}
              >
                Σ market
              </th>
              {data.months.map((m) => (
                <td
                  key={m.monthStart}
                  className="border-l px-2 py-1 text-right"
                  title={`${m.fullLabel} · ${m.marketKg == null ? "no purchases" : kgExact(m.marketKg)} — the monthly matrix's own Purchase volume figure.`}
                >
                  <span className="font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] font-semibold tabular-nums">
                    {t1(m.marketKg)}
                  </span>
                </td>
              ))}
              <td
                className="border-l bg-muted/40 px-2 py-1 text-right"
                title={`${kgExact(data.totalKg)} bought in ${data.year}.`}
              >
                <span className="font-mono text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] font-semibold tabular-nums">
                  {t1(data.totalKg)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {sellers.length > SUPPLIER_TOP_N && (
        <div>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            className="cursor-pointer rounded text-[length:var(--bw-fs-12)] leading-[var(--bw-lh-xs)] text-muted-foreground transition-colors duration-150 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showAll
              ? `Show the top ${SUPPLIER_TOP_N} only`
              : `Show all ${sellers.length} suppliers (${hidden} more)`}
          </button>
        </div>
      )}
    </div>
  );
}
