// No 'use client' — Server Component. Pure display, no interactivity (the
// Batch sub-label is a native `title`, not a shadcn Tooltip), so this band
// matches sync-summary.tsx / digest-footer-band.tsx rather than trucks-summary.
import { cn } from "@/lib/utils";
import { fmtKg, fmtPhpNumber } from "./format";
import type { OpenBlock } from "@/lib/digest/types";

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
 * Open Blocks — a COMPACT, at-a-glance CARD GRID of every currently-occupied
 * block (STORED / IN-USE), block_loc ascending. There are only a few in-use
 * blocks, so one card per block reads better than a dense table. Current
 * inventory state, NOT date-keyed (the "as of" label just reflects the latest
 * operational day for context).
 *
 * Each card, top→bottom: header (big block_loc + muted batch sub-label, status
 * dot+label top-right) · the centerpiece "volume left" bar (big balance kg +
 * % remaining, a left-anchored fill grown on mount via transform: scaleX) ·
 * a compact 7-stat lab mini-grid · an optional gated ₱/kg line.
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
              {/* Header: block_loc + batch (left), status dot + label (right). */}
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
                <span className="inline-flex shrink-0 items-center gap-1.5">
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

              {/* Lab stats — compact 7-chip mini-grid (glanceable, not a table). */}
              <div className="grid grid-cols-4 gap-x-3 gap-y-1.5">
                <LabStat label="MC" value={fmt2(b.mc)} />
                <LabStat label="ASH" value={fmt2(b.ash)} />
                <LabStat label="BD ASTM" value={fmt3(b.bdAstm)} />
                <LabStat label="BD JIS" value={fmt3(b.bdJis)} />
                <LabStat label="GRIT" value={fmt2(b.grit)} />
                <LabStat label="VM" value={fmt2(b.vm)} />
                <LabStat label="FC" value={fmt2(b.fc)} />
              </div>

              {/* Gated ₱/kg — only when some card carries a price; 0 ⇒ "—". */}
              {showPrice && (
                <div className="font-mono text-xs">
                  {b.phpKg === 0 || b.phpKg === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <span>
                      <span className="text-muted-foreground">₱</span>
                      {fmtPhpNumber(b.phpKg)}
                      <span className="text-muted-foreground">/kg</span>
                    </span>
                  )}
                </div>
              )}
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
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums">{value}</span>
    </div>
  );
}
