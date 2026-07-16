"use client";

// Client Component — the cards are interactive: clicking a block fetches a
// batch-accurate BlockData (fetchBlockDataForBatch) and opens the ESTABLISHED
// Blocking slide-over (BlockingDetailPanel). This mirrors the RC Movement
// matrix's exact click→fetch→panel pattern. Cross-importing the Blocking
// tenant code is fine — both this band and Blocking are charcoal-tenant code.
import * as React from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import { fmtKg, fmtPhpNumber } from "./format";
import type { OpenBlock } from "@/lib/digest/types";
import { fetchBlockDataForBatch } from "@/app/(app)/inventory/blocking/actions";
import type { BlockData } from "@/app/(app)/inventory/blocking/types";

// Lazily load the slide-over so the (heavy) Blocking detail panel + its edit /
// print dependencies stay out of the digest's initial bundle — the panel only
// mounts once a user actually clicks a block.
const BlockingDetailPanel = dynamic(
  () =>
    import("@/app/(app)/inventory/_shared/blocking-detail-panel").then(
      (m) => m.BlockingDetailPanel,
    ),
  { ssr: false },
);

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
 * single condensed row of all 7 lab stats.
 *
 * Each card is a CLICKABLE control: activating it fetches a batch-accurate
 * BlockData (fetchBlockDataForBatch) and opens the shared Blocking detail
 * slide-over (BlockingDetailPanel) with the full balance / quality / delivery
 * + usage history. Only one panel is open at a time.
 *
 * Price gating: the CARD ₱/kg is INFERRED from the data (no canViewPrices flag
 * on the contract — when Production is gated the backend nulls EVERY card's
 * phpKg, so an all-null set ⇒ no ₱ renders anywhere). The PANEL uses the
 * canViewPrices flag returned by fetchBlockDataForBatch (the canonical server
 * gate), independent of the card inference.
 *
 * Renders NOTHING when there are no open blocks (matches how other bands skip
 * empty content rather than show a hollow card).
 */
export function OpenBlocks({ openBlocks, operationalDate }: OpenBlocksProps) {
  // The block whose slide-over is open (null = closed), plus the fetched
  // batch-accurate summary + its price gate. One panel open at a time.
  const [selected, setSelected] = React.useState<OpenBlock | null>(null);
  const [panelBlockData, setPanelBlockData] = React.useState<BlockData | null>(
    null,
  );
  const [panelCanViewPrices, setPanelCanViewPrices] = React.useState(false);
  // The batchId currently being fetched (in-flight), so the clicked card can
  // show a subtle pending affordance until its data resolves and the panel opens.
  const [loadingBatchId, setLoadingBatchId] = React.useState<string | null>(
    null,
  );

  // The slide-over renders through a portal to document.body so it escapes this
  // band's transformed/blurred ancestors (hover-lift transform + backdrop-blur
  // both establish a containing block for position:fixed descendants, which
  // would otherwise anchor the fixed panel to the card instead of the viewport).
  // Guard on client mount so the portal only runs after hydration.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // Fetch FIRST, then open. The panel stays permanently mounted (see the render
  // below) in its closed (translate-x-full) state; we only flip it open once the
  // batch-accurate BlockData is ready — setting panelBlockData + selected in the
  // SAME tick. That way the panel transitions from mounted-closed straight to
  // open with content already present: one clean slide-in, no empty-panel flash.
  const handleSelect = React.useCallback((block: OpenBlock) => {
    setLoadingBatchId(block.batchId);
    fetchBlockDataForBatch(block.batchId).then((result) => {
      setPanelBlockData(result.blockData);
      setPanelCanViewPrices(result.canViewPrices);
      setSelected(block);
      setLoadingBatchId(null);
    });
  }, []);

  // Close only clears `selected` → locKey becomes null → the still-mounted panel
  // slides OUT (never unmounts). panelBlockData is intentionally left in place so
  // its content doesn't blank mid-animation; the closed branch ignores it anyway.
  const handleClose = React.useCallback(() => {
    setSelected(null);
  }, []);

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
          are allowed here (not the 100+-instance table case). Simplified cards
          (no ledger) let 2 blocks sit comfortably in the half-width column;
          they stack to 1-up only when the column gets narrow. */}
      <div className="stagger-fast grid grid-cols-1 gap-3 sm:grid-cols-2">
        {openBlocks.map((b, i) => {
          // Volume-left fraction, guarded against divide-by-zero and clamped 0–1.
          const fraction =
            b.totalInKg > 0
              ? Math.min(1, Math.max(0, b.balanceKg / b.totalInKg))
              : 0;
          const pct = fraction * 100;
          const pctLabel = Math.round(pct);
          const isSelected = selected?.batchId === b.batchId;
          const isLoading = loadingBatchId === b.batchId;

          return (
            <button
              type="button"
              key={`${b.blockLoc}-${b.batchCode}-${i}`}
              onClick={() => handleSelect(b)}
              disabled={isLoading}
              aria-busy={isLoading}
              aria-label={`Open details for ${b.blockLoc} (${b.batchCode})`}
              className={cn(
                "hover-lift flex cursor-pointer flex-col gap-3 rounded-xl border bg-card/95 p-4 text-left backdrop-blur transition-colors duration-150 supports-backdrop-filter:bg-card/70",
                "hover:border-primary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isSelected && "border-primary/60 ring-1 ring-primary/40",
                // In-flight: subtle pulse + primary ring so the click feels
                // responsive while BlockData loads (panel opens on resolve).
                isLoading && "animate-pulse border-primary/60 ring-1 ring-primary/40",
              )}
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
                  {/* Static final width via inline style (client-rendered);
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

              {/* Lab stats — a single condensed row of 6 (glanceable). BD ASTM
                  shortens to BDA so 6-up fits without wrapping. BD JIS is omitted
                  here (still shown in the shared BlockingDetailPanel lab row). */}
              <div className="grid grid-cols-6 gap-x-1.5">
                <LabStat label="MC" value={fmt2(b.mc)} />
                <LabStat label="ASH" value={fmt2(b.ash)} />
                <LabStat label="BDA" value={fmt3(b.bdAstm)} />
                <LabStat label="GRIT" value={fmt2(b.grit)} />
                <LabStat label="VM" value={fmt2(b.vm)} />
                <LabStat label="FC" value={fmt2(b.fc)} />
              </div>
            </button>
          );
        })}
      </div>

      {/* Shared Blocking slide-over — reused, NOT rebuilt. It is PERMANENTLY
          MOUNTED (once the client has hydrated) and animates purely via its
          internal locKey-driven translate-x transition: locKey null → it sits
          in its closed (translate-x-full) state; locKey set → it slides open;
          back to null → it slides shut, WITHOUT unmounting (so the exit slide
          plays). This mirrors the Blocking grid's always-mounted usage — the
          conditional mount was what killed both the enter and exit slides.
          blockData is the batch-accurate summary from fetchBlockDataForBatch
          (already resolved before we set `selected`, so no empty-panel flash);
          canViewPrices is the server gate it returns. onNavigateToBatch is
          OMITTED — the panel's internal fallback handles "Edit All" navigation.
          Portaled to document.body to escape this band's transformed/blurred
          ancestors (see the `mounted` note above). */}
      {mounted &&
        createPortal(
          <BlockingDetailPanel
            locKey={selected ? selected.blockLoc : null}
            blockData={panelBlockData}
            canViewPrices={panelCanViewPrices}
            onClose={handleClose}
          />,
          document.body,
        )}
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
