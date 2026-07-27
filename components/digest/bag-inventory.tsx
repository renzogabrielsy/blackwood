// No 'use client' — Server Component. Pure display, row-level passthrough.
import Link from "next/link";
import { format, parseISO, isValid } from "date-fns";
import { cn } from "@/lib/utils";
import type { FleconBagBalance } from "@/lib/digest/types";

interface BagInventoryProps {
  fleconBags: FleconBagBalance[];
}

// ---------------------------------------------------------------------------
// FLECON Bag Inventory — a dense Excel-Standard stock summary. One row per bag
// type, `sort_order` ascending (the workbook's left-to-right sheet column order
// C→P, which is the operator's mental model — NEVER re-sorted here).
//
// Conceptually this is the movement workbook's
//   Forwarded Balance → movements → Current Balance
// collapsed to ONE row per bag type:
//   BAG TYPE | OPENING | IN | OUT | BALANCE | LAST MOVE
//
// Every number is SQL-computed by `view_flecon_bag_balance` and passed straight
// through — NOTHING is summed or recomputed in TypeScript (project HARD RULE).
// There is deliberately NO totals row: summing bag counts across different
// capacities (1000kg vs 500kg sacks) is meaningless.
//
// Numeric vocabulary is borrowed verbatim from the full ledger page
// (`app/(app)/inventory/flecon-bags/components/flecon-bags-view.tsx`) so the
// band and the full page read as one product: blank-for-zero (Excel's
// blanks-are-zero convention), emerald IN, red OUT with the REAL minus glyph
// (U+2212, not a hyphen).
//
// No price data exists anywhere in this domain → `canViewPrices()` is not
// imported and nothing is gated. Renders NOTHING when there are no bag types
// (matches how the other digest bands skip empty content).
// ---------------------------------------------------------------------------

// Column geometry — Excel Standard: table-fixed + explicit pixel widths.
// BAG TYPE is the one flexible column (it absorbs leftover width on a wide
// screen); MIN_W below reserves a 180px FLOOR for it so it can never be the
// column that silently crushes ("never crush, always scroll", CLAUDE.md).
const COL = {
  // bagType intentionally has NO entry — it is the flexible column (`<col />`
  // with no width); its 180px floor is enforced by MIN_W below.
  opening: "w-[84px]",
  in: "w-[76px]",
  out: "w-[84px]",
  balance: "w-[92px]",
  lastMove: "w-[88px]", // fits the "Last move" header on ONE line
} as const;

// Sum of every column's minimum: 180 (bag-type floor) + 84 + 76 + 84 + 92 + 88.
// Below this the wrapper scrolls horizontally instead of compressing cells.
const MIN_W = "min-w-[604px]";

/** Plain integer, thousands-separated. Blank for 0 (Excel blanks-are-zero) —
 *  mirrors `fmtInt` in flecon-bags-view.tsx. */
function fmtInt(n: number): string {
  return n === 0 ? "" : n.toLocaleString("en-US");
}

/** `MM-dd` for a `yyyy-MM-dd` date; em-dash when the type has never moved.
 *  parseISO (NOT `new Date()`) so a date-only string parses as LOCAL midnight
 *  and can never drift a day backwards. */
function fmtLastMove(iso: string | null): string {
  if (!iso) return "—";
  const d = parseISO(iso);
  return isValid(d) ? format(d, "MM-dd") : "—";
}

export function BagInventory({ fleconBags }: BagInventoryProps) {
  if (!fleconBags.length) return null;

  const headCls =
    "bg-muted px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground";

  return (
    // min-w-0 is load-bearing: without it the flex/grid parent sizes to the
    // table's min-content and the PAGE scrolls sideways on tablet portrait
    // instead of the table scrolling inside its own card (see commits
    // 9471122 / 5d92772 — same class of bug, do not regress).
    <div className="hover-lift animate-fade-up flex min-w-0 flex-col rounded-xl border bg-card/95 p-4 backdrop-blur supports-backdrop-filter:bg-card/70">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight">Bag Inventory</h3>
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] text-muted-foreground">
            {fleconBags.length} types
          </span>
          <Link
            href="/inventory/flecon-bags"
            className="text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            Full ledger →
          </Link>
        </div>
      </div>

      {/* Wrapper scrolls sideways when the viewport is narrower than MIN_W. */}
      <div className="overflow-x-auto rounded-lg border">
        <table
          className={cn("w-full table-fixed border-collapse text-xs", MIN_W)}
        >
          <colgroup>
            {/* Bag type — flexible; absorbs leftover width, floor via MIN_W. */}
            <col />
            <col className={COL.opening} />
            <col className={COL.in} />
            <col className={COL.out} />
            <col className={COL.balance} />
            <col className={COL.lastMove} />
          </colgroup>
          <thead>
            <tr>
              <th className={cn(headCls, "text-left")}>Bag type</th>
              <th className={cn(headCls, "text-right")}>Opening</th>
              <th className={cn(headCls, "text-right")}>In</th>
              <th className={cn(headCls, "text-right")}>Out</th>
              <th className={cn(headCls, "text-right")}>Balance</th>
              <th className={cn(headCls, "text-right")}>Last move</th>
            </tr>
          </thead>
          <tbody>
            {fleconBags.map((b, i) => {
              const isZero = b.balance === 0;
              return (
                <tr
                  key={b.bagTypeId || b.code || i}
                  className={cn(
                    // No entrance animation on table rows (CLAUDE.md Motion);
                    // hover only, on the 150ms micro-interaction budget.
                    "h-8 border-t transition-all duration-150 hover:bg-muted/40",
                    // Zero-balance types keep their POSITION (spreadsheet users
                    // rely on stable row order) but render dimmed.
                    isZero && "text-muted-foreground opacity-70",
                  )}
                >
                  <td className="truncate px-2 py-1" title={b.label}>
                    {b.label}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                    {fmtInt(b.opening)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                    {fmtInt(b.totalIn)}
                  </td>
                  {/* total_out arrives as a POSITIVE magnitude from the view
                      (SUM(-qty_delta) WHERE qty_delta < 0) — render it with the
                      real minus glyph, exactly like the ledger's SignedQty. */}
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-red-600 dark:text-red-400">
                    {b.totalOut === 0 ? "" : `−${b.totalOut.toLocaleString("en-US")}`}
                  </td>
                  <td
                    className={cn(
                      "px-2 py-1 text-right font-mono font-semibold tabular-nums",
                      b.balance < 0 && "text-red-600 dark:text-red-400",
                    )}
                  >
                    {b.balance.toLocaleString("en-US")}
                  </td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums text-muted-foreground">
                    {fmtLastMove(b.lastMovementDate)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
