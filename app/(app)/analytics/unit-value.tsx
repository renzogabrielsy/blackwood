"use client";

// ─────────────────────────────────────────────────────────────────────────────
// UNIT ON THE LEFT — the accounting format, generalised (owner feedback R6)
//
// Renzo, 2026-09-02: *"let the left side of cells be the place where we
// indicate the unit. If it's money, ₱/kg; tonnes → T; percent → %. That would
// make things more clean."*
//
// This is not a new idea on this platform — it is CLAUDE.md's **Currency
// (Accounting format)** rule (`flex justify-between`, ₱ pinned left, the number
// pinned right) applied to every unit rather than only to pesos. Three things
// follow from it, and all three are why it reads cleaner:
//
//   1. **The digits keep the right edge.** A trailing suffix moves the last
//      digit whenever the unit's length changes (`t` vs `kWh/kg`), which is
//      exactly what `tabular-nums` exists to prevent. Pinning the unit left
//      leaves one clean column of numerals to scan down.
//   2. **The unit lands at a FIXED x.** Every row of a table announces its unit
//      in the same place, so the eye stops reading it and starts using it as a
//      landmark.
//   3. **It is one component, not a convention.** A glyph rendered inline in
//      nine components would have drifted in size, colour and spacing the first
//      time one was touched; here the muted 11px treatment the ₱ already had is
//      the only treatment there is.
//
// **What deliberately does NOT get a unit: the delta and comparison chips.**
// They sit under the value in a 15–16 px line and already carry a direction
// glyph, a sign and (for the second chip) a `Y` / `Δ` label. Adding `T` or
// `kWh/kg` to those would double their width in a 116 px column and bury the
// one thing they exist to show — which way the number moved. The row's unit is
// already stated on the value directly above them.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * ONE value, with its unit pinned left and its number pinned right.
 *
 * `glyph` empty renders the number alone, right-aligned — which is what a bare
 * count has always looked like, so a row with nothing useful to declare loses
 * nothing.
 */
export function UnitValue({
  glyph,
  children,
  className,
  glyphClassName,
  valueClassName,
  after,
}: {
  /** `₱/kg` · `T` · `%` · `h` · `kWh` · `bags`. Empty = no unit column. */
  glyph: string;
  /** The formatted number. */
  children: React.ReactNode;
  className?: string;
  glyphClassName?: string;
  valueClassName?: string;
  /** Marks that ride with the NUMBER — `~`, `⚠`, `·`. Never with the glyph. */
  after?: React.ReactNode;
}) {
  if (!glyph) {
    return (
      <div className={cn("flex items-baseline justify-end gap-1", className)}>
        <span className={cn("truncate", valueClassName)}>{children}</span>
        {after}
      </div>
    );
  }
  return (
    <div className={cn("flex items-baseline justify-between gap-1", className)}>
      <span
        className={cn(
          "shrink-0 text-[length:var(--bw-fs-11)] text-muted-foreground",
          glyphClassName,
        )}
      >
        {glyph}
      </span>
      <span className="flex min-w-0 items-baseline gap-0.5">
        <span className={cn("truncate", valueClassName)}>{children}</span>
        {after}
      </span>
    </div>
  );
}
