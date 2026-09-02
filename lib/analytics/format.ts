// =====================================================================
// ICTC Owner Analytics — display formatters
// =====================================================================
// Presentation only. No aggregation of any kind (that is `matrix.ts`, and
// the aggregation proper is SQL's). Client-safe.
//
// The house units: the MATRIX is in tonnes to one decimal, drill-downs
// stay in kg; ₱ is accounting format (glyph pinned left, number pinned
// right) wherever it sits in a cell of its own.
// =====================================================================

import type { MetricSpec, MetricUnit } from "./metrics";

/** A real minus glyph, so "−" lines up with "+" in a tabular-nums column. */
const MINUS = "−";

function nf(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * The magnitude a matrix cell prints — NUMBER ONLY. The ₱ glyph is a
 * separate node so the accounting layout (glyph left, number right) can be
 * built by the cell rather than baked into a string.
 */
export function fmtMetricValue(spec: MetricSpec, value: number): string {
  return nf(value, spec.decimals);
}

/**
 * ── OWNER FEEDBACK R6 — THE UNIT LIVES ON THE LEFT OF A CELL ────────────────
 *
 * Renzo: *"let the left side of cells be the place where we indicate the unit.
 * If it's money, ₱/kg; tonnes → T; percent → %. That would make things more
 * clean."*
 *
 * This is the project's existing **accounting format** — CLAUDE.md's
 * `flex justify-between`, glyph pinned left, number pinned right — generalised
 * from ₱ to every unit on the page. The value is what the eye scans down a
 * column, so it keeps the right edge and the `tabular-nums` alignment it
 * already had; the unit stops being a trailing suffix that shifts the digits
 * around and becomes a fixed marker at a fixed x.
 *
 * **One table, one place.** A glyph derived per component would have drifted
 * the first time a row changed unit; deriving it from `MetricUnit` means the
 * registry decides, exactly as it already decides the decimals.
 *
 * `count` is deliberately BLANK here — "12 what?" is a per-row question
 * (sellers, bags, piles) and `MetricSpec.glyph` answers it per row. A count
 * with no declared glyph simply renders as a bare number, which is what a
 * count has always been.
 */
export const UNIT_GLYPH: Record<MetricUnit, string> = {
  php_per_kg: "₱/kg",
  php: "₱",
  tonnes: "T",
  count: "",
  days: "d",
  pct: "%",
  hours: "h",
  kwh: "kWh",
  kwh_per_kg: "kWh/kg",
};

/**
 * The glyph one ROW prints on the left of every value cell.
 *
 * A row may override the unit's own glyph (`MetricSpec.glyph`), and only the
 * `count` rows do: `sellers`, `bags`, `piles` — each is a different thing being
 * counted, and a shared glyph would be wrong on two of the three.
 */
export function unitGlyphFor(spec: {
  unit: MetricUnit;
  glyph?: string;
}): string {
  return spec.glyph ?? UNIT_GLYPH[spec.unit];
}

/** The unit suffix a chart axis and a tooltip use. */
export function unitSuffix(unit: MetricUnit): string {
  switch (unit) {
    case "php_per_kg":
      return "₱/kg";
    case "php":
      return "₱";
    case "tonnes":
      return "t";
    case "days":
      return "days";
    case "pct":
      return "%";
    case "hours":
      return "h";
    case "kwh":
      return "kWh";
    case "kwh_per_kg":
      return "kWh/kg";
    default:
      return "";
  }
}

/** Compact axis tick — 12,480 → "12.5k", 1,250,000 → "1.25M". */
export function fmtCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  if (abs >= 100) return value.toFixed(0);
  return value.toFixed(abs >= 10 ? 1 : 2);
}

/** Signed percentage, one decimal — "+12.4%" / "−3.0%". */
export function fmtSignedPct(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  return `${sign}${nf(Math.abs(value), 1)}%`;
}

/** Signed raw difference in the row's own unit — "+6" / "−1.8". */
export function fmtSignedAbs(value: number, decimals: number): string {
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  return `${sign}${nf(Math.abs(value), decimals)}`;
}

/** The delta as the cell prints it, whichever mode the metric declares. */
export function fmtChange(
  change: { mode: "pct" | "abs"; value: number },
  spec: MetricSpec,
): string {
  return change.mode === "pct"
    ? fmtSignedPct(change.value)
    : fmtSignedAbs(change.value, spec.decimals);
}

/** ▲ / ▼ / · — DIRECTION only. Deliberately carries no good/bad colour: the
 *  plan withholds threshold semantics until Renzo states real targets, and a
 *  rising purchase price is not obviously "up" in the cheerful sense. */
export function directionGlyph(value: number): string {
  return value > 0 ? "▲" : value < 0 ? "▼" : "·";
}

/** Plain-language reason a cell is empty — the hover text on every blank. */
export const BLANK_TITLE: Record<string, string> = {
  restricted:
    "₱ figures are withheld for your role. Nothing was sent to this browser.",
  no_outflow:
    "Feedings were only recorded from January 2024, so this figure has no denominator before then. Blank, never zero.",
  no_production:
    "Production has only been reported since November 2025, so this figure has no numerator before then. Blank, never zero — a 0% yield would roll into a quarter as if the plant had turned charcoal into nothing.",
  no_data: "No records for this period.",
};

/**
 * The hover on the `~` an ESTIMATED cell carries.
 *
 * Some kilos were fed out of piles with no delivery record at all, so the
 * published price cannot speak for them; the figure shown is measured over
 * only the kilos it CAN price. Written once here because the matrix cell,
 * the row expand and the campaign panel all have to say the same thing.
 */
export function estimateTitle(coveragePct: number | null): string {
  const share =
    coveragePct == null
      ? "Some of the kilos behind this figure carry no price at all — they were fed out of piles with no delivery record."
      : `${nf(coveragePct, 1)}% of the kilos behind this figure carry a price; the rest were fed out of piles with no delivery record at all.`;
  return `${share} The figure shown is measured over only the kilos it can price, which is the honest answer — the raw published price would be dragged down by exactly the share it cannot see. An estimated figure is never quoted as a record or a biggest move.`;
}
