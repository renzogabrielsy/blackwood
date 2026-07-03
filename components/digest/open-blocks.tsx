// No 'use client' — Server Component. Pure display, no interactivity (the
// Batch sub-label is a native `title`, not a shadcn Tooltip), so this band
// matches sync-summary.tsx / digest-footer-band.tsx rather than trucks-summary.
import { cn } from "@/lib/utils";
import { fmtKg, fmtPhpNumber } from "./format";
import type { OpenBlock, OpenBlockDelivery } from "@/lib/digest/types";

interface OpenBlocksProps {
  openBlocks: OpenBlock[];
  operationalDate: string | null;
}

/** Lab stat at 2 dp (MC, ASH, GRIT, VM, FC). */
function fmt2(value: number): string {
  return value.toFixed(2);
}

/** Bulk-density stat at 3 dp (BD ASTM, BD JIS). */
function fmt3(value: number): string {
  return value.toFixed(3);
}

/**
 * Tailwind background for the volume-left bar fill, banded by how much of the
 * block remains (fraction = balanceKg / totalInKg, clamped 0–1):
 *   < 0.20  → red    (nearly depleted — reorder/feed-out warning)
 *   < 0.50  → primary (mid-life)
 *   ≥ 0.50  → emerald (healthy / freshly stocked)
 * Single solid fill tokens read correctly in both light and dark, matching
 * kpi-hero's emerald-500 / red-500 intensity.
 */
function depletionFill(fraction: number): string {
  if (fraction < 0.2) return "bg-red-500";
  if (fraction < 0.5) return "bg-primary";
  return "bg-emerald-500";
}

/**
 * Open Blocks — a COMPACT, at-a-glance CARD GRID of every currently in-use
 * block (status = IN-USE), block_loc ascending. There are only a few in-use
 * blocks, so one card per block reads better than a dense table. Current
 * inventory state, NOT date-keyed (the "as of" label just reflects the latest
 * operational day for context).
 *
 * Each card, top→bottom: header (big block_loc + muted batch sub-label on the
 * left; status dot+label with the gated weighted ₱/kg stacked beneath it,
 * right-aligned) · the centerpiece "volume left" bar (big balance kg + %
 * remaining, a left-anchored fill grown on mount via transform: scaleX) · a
 * single condensed row of all 7 lab stats · a compact per-delivery ledger
 * (Date · Supplier · MC · BD ASTM · ASH · Price) — omitted when the block has
 * no delivery rows.
 *
 * Price gating is INFERRED from the data: there is no canViewPrices flag on the
 * contract. When the Production role is gated, the backend nulls EVERY card's
 * phpKg, so an all-null set ⇒ gated ⇒ no ₱ element is rendered ANYWHERE. A
 * visible `0` means "no priced deliveries on record" and renders as "—"
 * (distinct from null = gated).
 *
 * Renders NOTHING when there are no open blocks (matches how other bands skip
 * empty content rather than show a hollow card).
 */
export function OpenBlocks({ openBlocks, operationalDate }: OpenBlocksProps) {
  if (!openBlocks.length) return null;

  // All cards nulled ⇒ Production role ⇒ render no ₱ element anywhere.
  const showPrice = openBlocks.some((b) => b.phpKg !== null);

  return (
    <div className="hover-lift animate-fade-up flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">Open Blocks</h3>
        <span className="font-mono text-[11px] text-muted-foreground">
          {openBlocks.length} block{openBlocks.length === 1 ? "" : "s"}
          {operationalDate ? ` · as of ${operationalDate}` : ""}
        </span>
      </div>

      {/* Card grid — small (≤ a handful) group, so per-card stagger + hover-lift
          are allowed here (not the 100+-instance table case). */}
      <div className="stagger-fast grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {openBlocks.map((b, i) => {
          // Volume-left fraction, guarded against divide-by-zero and clamped 0–1.
          const fraction =
            b.totalInKg > 0
              ? Math.min(1, Math.max(0, b.balanceKg / b.totalInKg))
              : 0;
          const pct = fraction * 100;
          const pctLabel = Math.round(pct);

          return (
            <div
              key={`${b.blockLoc}-${b.batchCode}-${i}`}
              className="hover-lift flex flex-col gap-3 rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70"
            >
              {/* Header: block_loc + batch (left); status dot + label with the
                  weighted ₱/kg stacked beneath it (right, right-aligned). */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-lg font-semibold tracking-tight">
                    {b.blockLoc}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    title={b.batchCode}
                  >
                    {b.batchCode}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        b.status === "IN-USE"
                          ? "bg-primary"
                          : "bg-muted-foreground/40",
                      )}
                      aria-hidden
                    />
                    <span className="text-[11px] text-muted-foreground">
                      {b.status}
                    </span>
                  </span>
                  {/* Gated weighted ₱/kg headline — only when some card carries a
                      price; a per-card 0/null ⇒ "—". */}
                  {showPrice &&
                    (b.phpKg === 0 || b.phpKg === null ? (
                      <span className="font-mono text-sm text-muted-foreground">
                        —
                      </span>
                    ) : (
                      <span className="font-mono text-sm">
                        <span className="text-muted-foreground">₱</span>
                        {fmtPhpNumber(b.phpKg)}
                        <span className="text-muted-foreground">/kg</span>
                      </span>
                    ))}
                </div>
              </div>

              {/* Volume-left bar — the visual focus. */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-baseline gap-1">
                    <span className="font-mono text-2xl font-semibold tabular-nums">
                      {fmtKg(b.balanceKg)}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      kg left
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {pctLabel}% remaining
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  {/* Static final width via inline style (server-rendered);
                      origin-left overrides animate-status-grow's right-center
                      origin so the fill grows from the LEFT on mount. Only the
                      compositor-friendly transform/opacity animate — never width. */}
                  <div
                    className={cn(
                      "h-full origin-left animate-status-grow rounded-full",
                      depletionFill(fraction),
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  of {fmtKg(b.totalInKg)}
                </div>
              </div>

              {/* Lab stats — a single condensed row of all 7 (glanceable). BD
                  labels shorten to BDA/BDJ so 7-up fits without wrapping. */}
              <div className="grid grid-cols-7 gap-x-1.5">
                <LabStat label="MC" value={fmt2(b.mc)} />
                <LabStat label="ASH" value={fmt2(b.ash)} />
                <LabStat label="BDA" value={fmt3(b.bdAstm)} />
                <LabStat label="BDJ" value={fmt3(b.bdJis)} />
                <LabStat label="GRIT" value={fmt2(b.grit)} />
                <LabStat label="VM" value={fmt2(b.vm)} />
                <LabStat label="FC" value={fmt2(b.fc)} />
              </div>

              {/* Per-delivery ledger — compact mini-table, newest first (backend
                  order preserved). Read defensively; omit entirely when empty. */}
              <DeliveryLedger
                rows={b.deliveries ?? []}
                showPrice={showPrice}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One lab-stat chip: tiny uppercase label over a mono value. */
function LabStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}

/** A single ledger numeric cell: right-aligned mono, "—" (muted) when null. */
function LedgerNum({ value, dp }: { value: number | null; dp: 2 | 3 }) {
  return (
    <td className="px-1 py-0.5 text-right font-mono tabular-nums">
      {value === null ? (
        <span className="text-muted-foreground">—</span>
      ) : dp === 3 ? (
        fmt3(value)
      ) : (
        fmt2(value)
      )}
    </td>
  );
}

/**
 * Compact per-delivery ledger for one open block — a real table (Excel Standard
 * density: text-[10px] body, tight px-1 py-0.5, mono right-aligned numerics).
 * Columns: Date · Supplier · MC · BD ASTM · ASH · Price. The Price column
 * (header + cells) is present ONLY when `showPrice`; a per-row null/0 price ⇒
 * "—". Rows arrive newest-first from the backend — NOT re-sorted here. Renders
 * nothing when there are no rows (never a hollow table shell). Not animated —
 * table rows are exempt from the motion system.
 */
function DeliveryLedger({
  rows,
  showPrice,
}: {
  rows: OpenBlockDelivery[];
  showPrice: boolean;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Deliveries
      </span>
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr className="text-[9px] uppercase tracking-wide text-muted-foreground">
            <th className="w-[44px] px-1 py-0.5 text-left font-medium">Date</th>
            <th className="px-1 py-0.5 text-left font-medium">Supplier</th>
            <th className="w-[52px] px-1 py-0.5 text-right font-mono font-medium tabular-nums">
              MC
            </th>
            <th className="w-[56px] px-1 py-0.5 text-right font-mono font-medium tabular-nums">
              BD ASTM
            </th>
            <th className="w-[52px] px-1 py-0.5 text-right font-mono font-medium tabular-nums">
              ASH
            </th>
            {showPrice && (
              <th className="w-[64px] px-1 py-0.5 text-right font-mono font-medium tabular-nums">
                Price
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => (
            <tr key={`${d.date}-${d.supplier}-${i}`} className="text-[10px]">
              <td className="px-1 py-0.5 text-left font-mono tabular-nums">
                {d.date.slice(5)}
              </td>
              <td
                className="max-w-[120px] truncate px-1 py-0.5 text-left"
                title={d.supplier}
              >
                {d.supplier}
              </td>
              <LedgerNum value={d.mc} dp={2} />
              <LedgerNum value={d.bdAstm} dp={3} />
              <LedgerNum value={d.ash} dp={2} />
              {showPrice && (
                <td className="px-1 py-0.5 text-right font-mono tabular-nums">
                  {d.price === null || d.price === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      <span className="text-muted-foreground">₱</span>
                      {fmtPhpNumber(d.price)}
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
