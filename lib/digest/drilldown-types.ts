// =====================================================================
// Digest drill-downs — shared data contract (client- AND server-safe)
// =====================================================================
// The types behind the KPI-tile / chart-card drill-down modals. They live
// HERE rather than beside the actions because a `'use server'` module may
// export nothing but async functions — a type export there is a build
// error — and five client components need these shapes.
//
// Same discipline as `lib/digest/types.ts`: a normalized, presentation-
// ready contract the modal consumes without knowing which view filled it
// (the port; `app/(app)/drilldown-actions.ts` is the adapter).
//
// NOTHING here carries a ₱ except `PriceDrilldown`, whose whole payload is
// gated SERVER-SIDE by `canViewPrices()` — see `restricted`.
// =====================================================================

/** The three windows a drill-down can be read over. */
export type DrilldownRange = "30d" | "90d" | "ytd";

/** What one point on the x-axis stands for. `ytd` reads as months because a
 *  240-bar daily axis is unreadable AND the daily digest views are windowed
 *  to a trailing 120 days in SQL (see the header of lib/digest/queries.ts). */
export type DrilldownGranularity = "day" | "month";

export const RANGE_LABEL: Record<DrilldownRange, string> = {
  "30d": "30 days",
  "90d": "90 days",
  ytd: "This year",
};

/** Short toggle captions — the modal's segmented control. */
export const RANGE_SHORT: Record<DrilldownRange, string> = {
  "30d": "30d",
  "90d": "90d",
  ytd: "This year",
};

// ---------------------------------------------------------------------
// RC IN
// ---------------------------------------------------------------------

/** One bar of the RC IN drill-down chart. */
export interface RcInPoint {
  /** yyyy-MM-dd (day granularity) or yyyy-MM (month granularity) */
  bucket: string;
  /** short axis label — "08-14" / "Aug" */
  label: string;
  /** kg received in the bucket. 0 is REAL here (a day with no delivery is a
   *  fact worth seeing on a bar chart — unlike a line, a zero bar does not
   *  "plunge", it simply is not drawn). */
  kg: number;
  /** trailing rolling mean over the bucketed series (7 buckets at day
   *  granularity, 3 at month). null until the window has filled. A
   *  presentational mean of already-bucketed values — see `avg7` in
   *  lib/digest/queries.ts for the same, blessed, pattern. */
  avg: number | null;
}

/** One row of the by-supplier ranking for the selected range. */
export interface RcInSupplierSlice {
  /** The CANONICAL supplier, `public.canonical_supplier(supplier)` — the ONE
   *  definition of supplier identity, applied in SQL by
   *  `view_digest_rcin_supplier_daily` and shared with every Summaries
   *  by-supplier view. Always UPPER; render it as given. It is NOT the raw
   *  stored spelling — `RcInRecentRow.supplier` is, deliberately. */
  supplier: string;
  kg: number;
  /** kg / range total, 0–100, 1 dp. */
  sharePct: number;
  deliveries: number;
  sacks: number;
}

/** One underlying delivery, for the "recent rows" table. Carries NO ₱ —
 *  `cost_basis` is never selected, so the RC IN drill-down has no price
 *  surface to gate. */
export interface RcInRecentRow {
  id: string;
  date: string;
  /** The RAW STORED spelling, on purpose — these are the underlying records,
   *  so they must read as the row reads. The canonical name lives on
   *  `RcInSupplierSlice.supplier`. */
  supplier: string;
  truckPlate: string | null;
  sacks: number | null;
  weightKg: number;
}

export interface RcInSummary {
  totalKg: number;
  /** mean kg over the buckets that actually had a delivery (null when none). */
  avgPerActiveBucket: number | null;
  /** the single heaviest bucket in the range. */
  peak: { bucket: string; label: string; kg: number } | null;
  /** buckets with kg > 0. */
  activeBuckets: number;
  deliveryCount: number;
  supplierCount: number;
}

export interface RcInDrilldown {
  kind: "rc_in";
  range: DrilldownRange;
  granularity: DrilldownGranularity;
  /** inclusive window bounds, yyyy-MM-dd */
  startDate: string;
  endDate: string;
  series: RcInPoint[];
  summary: RcInSummary;
  suppliers: RcInSupplierSlice[];
  recent: RcInRecentRow[];
  /** TRUE when the underlying row read hit its explicit cap. Every figure is
   *  then a FLOOR, not a total, and the modal says so rather than quietly
   *  reporting a short number. */
  truncated: boolean;
}

// ---------------------------------------------------------------------
// RC In price (₱/kg) — the ONE price-gated payload here
// ---------------------------------------------------------------------

export interface PricePointDrill {
  bucket: string;
  label: string;
  /** weighted-average ₱/kg for the bucket, computed in SQL. null = the bucket
   *  had no priced market purchase (never 0 — 0 is the L-008 unpriced
   *  placeholder and must never be drawn as a price). */
  phpPerKg: number | null;
  /** % change vs the PREVIOUS bucket in the series; null for the first point
   *  and across a gap. Pure display math over an already-correct series. */
  changePct: number | null;
}

export interface PriceSummary {
  /** lowest / highest bucket price in the range (null when the series is empty) */
  minPhp: number | null;
  maxPhp: number | null;
  /** MEAN OF THE BUCKET PRICES — deliberately NOT a range weighted average.
   *  A true weighted average is `SUM(kg × ₱)/SUM(kg)` and belongs in SQL
   *  (project HARD RULE); this is the same presentational mean `avg7` takes
   *  and the UI labels it as such. */
  meanPhp: number | null;
  /** the most recent bucket's price. */
  latestPhp: number | null;
  /** the largest single bucket-over-bucket move, signed. */
  biggestSwing: { bucket: string; label: string; pct: number } | null;
}

export interface PriceDrilldown {
  kind: "rc_in_price";
  range: DrilldownRange;
  granularity: DrilldownGranularity;
  startDate: string;
  endDate: string;
  /** TRUE when the caller's role may not view prices. The payload then carries
   *  NO ₱ AT ALL (empty series, all-null summary) — the gate is the server
   *  boundary, never a client-side hide. */
  restricted: boolean;
  series: PricePointDrill[];
  summary: PriceSummary;
  /** At MONTH granularity the series comes from the monthly delivery analytics
   *  view, whose market-purchase population excludes sundry / refeed /recook
   *  re-processing — a slightly different set from the daily price view. Set so
   *  the modal can SAY that rather than silently mixing two definitions. */
  populationNote: string | null;
}
