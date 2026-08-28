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
// Shared shapes — the volume drill-downs (RC OUT / PRODUCTION / POWER)
// ---------------------------------------------------------------------
// RC IN keeps its own `RcInPoint` / `RcInSummary` because it predates these
// and its field names (`kg`) are load-bearing in its chart's dataKeys. Every
// LATER volume drill-down shares the two shapes below, so the bar+rolling-mean
// chart and the summary strip have ONE definition each rather than four.

/** One bar of a volume drill-down chart, plus its trailing rolling mean.
 *  `value` is kg or kWh depending on the drill-down; the unit is carried by
 *  the presentation, never by the number. */
export interface VolumePoint {
  /** yyyy-MM-dd (day granularity) or yyyy-MM (month granularity) */
  bucket: string;
  /** short axis label — "08-14" / "Aug" */
  label: string;
  /** the bucket's total. 0 is REAL — a bar simply is not drawn, which is an
   *  honest gap; unlike a line it never "plunges" to the floor. */
  value: number;
  /** trailing rolling mean (7 buckets at day granularity, 3 at month), null
   *  until the window has filled. INCLUDES zero buckets — that is what makes
   *  it an average of the PERIOD rather than of the busy days. */
  avg: number | null;
}

/** The four figures every volume drill-down's summary strip shows. */
export interface VolumeSummary {
  total: number;
  /** mean over the buckets that actually carried activity (null when none). */
  avgPerActiveBucket: number | null;
  peak: { bucket: string; label: string; value: number } | null;
  activeBuckets: number;
}

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

// ---------------------------------------------------------------------
// RC OUT — kg fed
// ---------------------------------------------------------------------

/** One row of the by-BATCH ranking. The rail ranks by batch and NOT by
 *  destination on purpose: the 400-day window is 93.8% MAIN by row and 94.9%
 *  by kg, so a destination rail would print one bar and say nothing. */
export interface RcOutBatchSlice {
  batchCode: string;
  /** The block the charcoal was fed from. NULL when `rc_out` stored a BLANK
   *  there (491 of 1,266 windowed rows) — a blank is "unrecorded", not "".
   *  When one batch was fed from several blocks this is the heaviest one and
   *  `blockCount` says how many there were. */
  blockLoc: string | null;
  blockCount: number;
  /** Distinct destinations OTHER than MAIN. Empty for the overwhelming
   *  majority; non-empty is the interesting case (a SUNDRY move), which is the
   *  only time the UI prints a destination at all. */
  otherDestinations: string[];
  kg: number;
  /** kg / range total, 0–100, 1 dp. */
  sharePct: number;
  feedings: number;
}

/** One underlying `rc_out` row for the "recent feedings" table. No ₱ — the
 *  computed `rc_out_avg_price` / `rc_out_avg_wtd_value` columns are never
 *  selected, so this surface has nothing to gate. */
export interface RcOutRecentRow {
  id: string;
  date: string;
  batchCode: string;
  blockLoc: string | null;
  destination: string;
  weightKg: number;
}

export interface RcOutDrilldown {
  kind: "rc_out";
  range: DrilldownRange;
  granularity: DrilldownGranularity;
  startDate: string;
  endDate: string;
  /** The stream's latest REPORTED day (`view_digest_stream_status.through_date`).
   *  RC OUT is filed the morning after, so the modal states the as-of date
   *  explicitly rather than letting the window's end read as "today". */
  asOf: string | null;
  series: VolumePoint[];
  summary: VolumeSummary & { feedingCount: number; batchCount: number };
  batches: RcOutBatchSlice[];
  recent: RcOutRecentRow[];
  /** TRUE when a row read hit its explicit cap — every figure is then a FLOOR.
   *  This one genuinely fires: the batch-day grain runs ~4.2 rows per operating
   *  day, so a late-in-year "This year" read can reach the 1000-row cap. */
  truncated: boolean;
}

// ---------------------------------------------------------------------
// PRODUCTION — kg produced
// ---------------------------------------------------------------------

export interface ProductionGradeSlice {
  grade: string;
  kg: number;
  sharePct: number;
  runs: number;
  /** Bagged sacks. **NULL is not 0** — 218 of 324 windowed runs record no sack
   *  count at all, so a grade whose runs never carried one reads "not
   *  recorded". `runsWithSacks` qualifies a partial figure. */
  sacks: number | null;
  runsWithSacks: number;
}

export interface ProductionRecentRow {
  id: string;
  date: string;
  /** M / E / N, from the parent `production_shifts` row. */
  shift: string | null;
  grade: string;
  kg: number;
  /** null = the run recorded no sack count (never rendered as 0). */
  sacks: number | null;
}

export interface ProductionDrilldown {
  kind: "production";
  range: DrilldownRange;
  granularity: DrilldownGranularity;
  startDate: string;
  endDate: string;
  /** Latest reported day — production is filed the morning after. */
  asOf: string | null;
  series: VolumePoint[];
  summary: VolumeSummary & {
    runCount: number;
    gradeCount: number;
    /** total bagged sacks, or null when NO run in the window recorded any. */
    sacks: number | null;
    runsWithSacks: number;
  };
  grades: ProductionGradeSlice[];
  recent: ProductionRecentRow[];
  truncated: boolean;
}

// ---------------------------------------------------------------------
// POWER — kWh consumed
// ---------------------------------------------------------------------

export interface PowerMeterSlice {
  meter: string;
  kwh: number;
  sharePct: number;
  readings: number;
}

export interface PowerRecentRow {
  id: string;
  date: string;
  meter: string;
  /** `consumption_kwh` is nullable in the source table. */
  kwh: number | null;
}

export interface PowerDrilldown {
  kind: "power";
  range: DrilldownRange;
  granularity: DrilldownGranularity;
  startDate: string;
  endDate: string;
  /** Latest reported day — electricity is filed the morning after. */
  asOf: string | null;
  series: VolumePoint[];
  summary: VolumeSummary & { readingCount: number; meterCount: number };
  /** Ranked by meter. **A ONE-BAR RAIL IS CORRECT DATA, NOT AN EMPTY STATE** —
   *  BUNKHOUSE and PUMP were last reported 2025-12-12, so a 30d/90d range
   *  legitimately shows MAIN alone. The UI renders it plainly. */
  meters: PowerMeterSlice[];
  recent: PowerRecentRow[];
  truncated: boolean;
}

// ---------------------------------------------------------------------
// FLOW — received vs fed, and the net between them
// ---------------------------------------------------------------------
// ONE payload serves BOTH the NET FLOW KPI tile and the Feed In vs Out chart
// card: they are the same two series and the same arithmetic, differing only
// in which mark the reader is meant to look at first. Two payloads would be
// two definitions of "net", and they would eventually disagree.
//
// NO VIEW backs this. It is derived as RC IN daily (the supplier view summed
// per day) minus RC OUT daily (the batch view summed per day) — measured
// against `view_digest_daily_flow` across its whole 121-day window: in 121/121,
// out 121/121, net 121/121.

export interface FlowPointDrill {
  bucket: string;
  label: string;
  /** kg received. 0 is real — procurement is not shift-bound. */
  inKg: number;
  /** kg fed. 0 is real, and on the operational date it is the NORMAL reading:
   *  RC OUT is filed the following morning. */
  outKg: number;
  /** inKg − outKg. Signed; a negative bucket means the plant drew down stock. */
  netKg: number;
}

export interface FlowDrilldown {
  kind: "flow";
  range: DrilldownRange;
  granularity: DrilldownGranularity;
  startDate: string;
  endDate: string;
  series: FlowPointDrill[];
  summary: {
    inKg: number;
    outKg: number;
    netKg: number;
    /** mean net over the buckets where EITHER side moved (null when none). */
    avgNetPerBucket: number | null;
    biggestSurplus: { bucket: string; label: string; netKg: number } | null;
    biggestDeficit: { bucket: string; label: string; netKg: number } | null;
    activeBuckets: number;
  };
  truncated: boolean;
}
