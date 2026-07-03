// No 'use client' — Server Component. Pure display, mirrors open-blocks.tsx.
import { cn } from "@/lib/utils";
import type { FleconBagBalance } from "@/lib/digest/types";

interface BagInventoryProps {
  fleconBags: FleconBagBalance[];
}

/**
 * FLECON Bag Inventory — a compact at-a-glance chip group of every bag type's
 * current balance, sort_order ascending (backend order preserved). One chip per
 * bag type: label + balance. Zero-balance chips render dimmed/muted; non-zero
 * chips read prominent. No price data anywhere in this domain — nothing gated.
 *
 * Balances are SQL-computed (view_flecon_bag_balance); this is a row-level
 * passthrough and NEVER re-sums in TS. Renders NOTHING when there are no bag
 * types (matches how other digest bands skip empty content).
 */
export function BagInventory({ fleconBags }: BagInventoryProps) {
  if (!fleconBags.length) return null;

  return (
    <div className="hover-lift animate-fade-up flex flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">Bag Inventory</h3>
        <span className="font-mono text-[11px] text-muted-foreground">
          {fleconBags.length} types
        </span>
      </div>

      {/* Small group (≤ a handful of bag types) → per-chip stagger allowed. */}
      <div className="stagger-fast flex flex-wrap gap-2">
        {fleconBags.map((b, i) => {
          const isZero = b.balance === 0;
          return (
            <div
              key={b.bagTypeId || b.code || i}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2 py-1",
                isZero
                  ? "border-border/50 text-muted-foreground opacity-70"
                  : "",
              )}
            >
              <span className="max-w-[160px] truncate text-xs" title={b.label}>
                {b.label}
              </span>
              <span className="font-mono text-xs tabular-nums">
                {b.balance.toLocaleString("en-US")}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
