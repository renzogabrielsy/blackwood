"use server";

// =====================================================================
// Digest drill-downs — the ADAPTER behind the KPI-tile / chart-card modals
// =====================================================================
// Server actions called from the digest's client bands when a tile or a
// chart card is expanded. They fill the data-agnostic contract in
// `lib/digest/drilldown-types.ts`; the modal never learns which view
// answered.
//
// Same rules as the digest adapter (`lib/digest/queries.ts`):
//
//   • READ-ONLY, EXISTING relations only. No new view, no migration, no
//     RPC. Every read is WINDOWED or LIMITed — an unwindowed daily read
//     is silently truncated at PostgREST's 1000-row cap (see that file's
//     header for the incident this rule comes from).
//
//   • ₱ IS A SECURITY BOUNDARY. `getRcInPriceDrilldown` resolves
//     `canViewPrices()` FIRST and returns an empty, `restricted: true`
//     payload for a denied role — the ₱ never enters the response, it is
//     not hidden on the client. `getRcInDrilldown` never selects
//     `cost_basis` at all, so it has no price surface to gate.
//
//   • AGGREGATION. The project HARD RULE puts weighted averages, balances
//     and running totals in SQL. Two things follow, and the split is
//     deliberate:
//       - the PRICE series is a weighted average, so it is read from SQL
//         at BOTH granularities (`view_digest_daily_price` /
//         `view_delivery_monthly_analytics.avg_price`) and never computed
//         here;
//       - RC IN is a plain SUM of kg. Its buckets are rolled up in this
//         module from the range's delivery rows because the canonical
//         daily view (`view_digest_daily_flow`) is windowed to 120 days
//         and cannot reach "this year", and because the by-supplier
//         ranking has no SQL home at all (there is no per-supplier daily
//         view, and PostgREST aggregate functions are DISABLED on this
//         project — a `weight_kg.sum()` select returns PGRST123). The
//         rollup REPRODUCES `view_digest_daily_flow`'s definition exactly
//         (`sum(weight_kg) GROUP BY transaction_date` over `deliveries`,
//         unfiltered), so it is the same definition applied to a wider
//         window, not a second one. MEASURED 2026-08-28: over the 90 days
//         to the operational date the two agree on 90 of 90 days, zero
//         mismatches. If this ever grows a second consumer, promote it to
//         a windowed SQL view instead of copying the rollup.
// =====================================================================

import { createClient } from "@/lib/supabase/server";
import { canViewPrices } from "@/lib/auth";
import type {
  DrilldownRange,
  DrilldownGranularity,
  RcInDrilldown,
  RcInPoint,
  RcInRecentRow,
  RcInSupplierSlice,
  PriceDrilldown,
  PricePointDrill,
} from "@/lib/digest/drilldown-types";

/** Hard cap on the row read. YTD measured 635 delivery rows (2026); the cap is
 *  a guard against an unexpected year, not an expected boundary. Hitting it
 *  sets `truncated`, and the modal then presents every figure as a FLOOR. */
const ROW_CAP = 1500;

/** Trailing rolling-mean window, per granularity. */
const ROLLING_BUCKETS: Record<DrilldownGranularity, number> = {
  day: 7,
  month: 3,
};

/** How many recent underlying rows the modal lists. */
const RECENT_ROWS = 10;

// ---------------------------------------------------------------------
// pure date helpers (UTC-anchored — a yyyy-MM-dd is a calendar date, never
// a local instant; `new Date(str)` would drift a day in Asia/Manila)
// ---------------------------------------------------------------------

function toISODate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseISODate(date: string): number {
  return Date.parse(date + "T00:00:00Z");
}

function addDays(date: string, days: number): string {
  return toISODate(parseISODate(date) + days * 86_400_000);
}

/** "2026-08-14" → "08-14"; "2026-08" → "Aug". */
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function dayLabel(bucket: string): string {
  return bucket.slice(5);
}

function monthLabel(bucket: string): string {
  const m = Number(bucket.slice(5, 7));
  return MONTH_NAMES[m - 1] ?? bucket;
}

const n = (v: number | string | null | undefined): number =>
  v == null ? 0 : typeof v === "number" ? v : Number(v);

const round = (v: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Every calendar day from start→end inclusive (zero-fill axis). */
function dayBuckets(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Every yyyy-MM from start→end inclusive. */
function monthBuckets(start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Trailing mean of the last `window` values ending at index i (inclusive).
 *  Returns null until the window has filled, so a partial average is never
 *  drawn as if it were the real trend. Presentational rollup of ALREADY
 *  bucketed values — the same class as `avg7` in lib/digest/queries.ts. */
function rollingMean(values: number[], i: number, window: number): number | null {
  if (i + 1 < window) return null;
  let sum = 0;
  for (let k = i - window + 1; k <= i; k++) sum += values[k];
  return round(sum / window);
}

/** Resolve the inclusive window for a range against the operational date. */
function resolveWindow(
  range: DrilldownRange,
  operationalDate: string
): { startDate: string; endDate: string; granularity: DrilldownGranularity } {
  if (range === "ytd") {
    return {
      startDate: `${operationalDate.slice(0, 4)}-01-01`,
      endDate: operationalDate,
      granularity: "month",
    };
  }
  const days = range === "30d" ? 30 : 90;
  return {
    startDate: addDays(operationalDate, -(days - 1)),
    endDate: operationalDate,
    granularity: "day",
  };
}

/** The digest's operational date — the latest business day with ANY data.
 *  Falls back to today (UTC) so a drill-down still opens on a cold database. */
async function resolveOperationalDate(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<string> {
  const { data } = await supabase
    .from("view_digest_operational_days")
    .select("operational_date")
    .maybeSingle();
  const value = (data as { operational_date: string | null } | null)
    ?.operational_date;
  return value ?? toISODate(Date.now());
}

// =====================================================================
// RC IN — kg received
// =====================================================================

interface DeliveryRow {
  id: string;
  transaction_date: string | null;
  supplier: string | null;
  truck_plate: string | null;
  sacks: number | string | null;
  weight_kg: number | string | null;
}

export async function getRcInDrilldown(
  range: DrilldownRange
): Promise<RcInDrilldown> {
  const supabase = await createClient();
  const operationalDate = await resolveOperationalDate(supabase);
  const { startDate, endDate, granularity } = resolveWindow(
    range,
    operationalDate
  );

  // ONE windowed, explicitly-capped row read. DESC so a truncated read keeps
  // the MOST RECENT rows (the ones the recent-rows table shows) rather than an
  // arbitrary head. No `cost_basis` in the select — this payload carries no ₱.
  const { data, error } = await supabase
    .from("deliveries")
    .select("id, transaction_date, supplier, truck_plate, sacks, weight_kg")
    .gte("transaction_date", startDate)
    .lte("transaction_date", endDate)
    .order("transaction_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(ROW_CAP);

  if (error) {
    throw new Error(`RC IN drill-down query failed: ${error.message}`);
  }

  const rows = (data as DeliveryRow[] | null) ?? [];
  const truncated = rows.length >= ROW_CAP;

  // ---- bucket the rows (see the module header: this reproduces
  //      view_digest_daily_flow's definition, it is not a second one) ----
  const kgByBucket = new Map<string, number>();
  const supplierAgg = new Map<
    string,
    { kg: number; deliveries: number; sacks: number }
  >();
  let totalKg = 0;

  for (const r of rows) {
    if (!r.transaction_date) continue;
    const kg = n(r.weight_kg);
    const bucket =
      granularity === "month"
        ? r.transaction_date.slice(0, 7)
        : r.transaction_date;
    kgByBucket.set(bucket, (kgByBucket.get(bucket) ?? 0) + kg);
    totalKg += kg;

    const supplier = (r.supplier ?? "").trim() || "Unattributed";
    const agg = supplierAgg.get(supplier) ?? {
      kg: 0,
      deliveries: 0,
      sacks: 0,
    };
    agg.kg += kg;
    agg.deliveries += 1;
    agg.sacks += n(r.sacks);
    supplierAgg.set(supplier, agg);
  }

  const buckets =
    granularity === "month"
      ? monthBuckets(startDate, endDate)
      : dayBuckets(startDate, endDate);
  const values = buckets.map((b) => round(kgByBucket.get(b) ?? 0));
  const window = ROLLING_BUCKETS[granularity];

  const series: RcInPoint[] = buckets.map((bucket, i) => ({
    bucket,
    label: granularity === "month" ? monthLabel(bucket) : dayLabel(bucket),
    kg: values[i],
    avg: rollingMean(values, i, window),
  }));

  const active = series.filter((p) => p.kg > 0);
  const peakPoint = active.reduce<RcInPoint | null>(
    (best, p) => (best === null || p.kg > best.kg ? p : best),
    null
  );

  const suppliers: RcInSupplierSlice[] = Array.from(supplierAgg.entries())
    .map(([supplier, agg]) => ({
      supplier,
      kg: round(agg.kg),
      sharePct: totalKg > 0 ? round((agg.kg / totalKg) * 100, 1) : 0,
      deliveries: agg.deliveries,
      sacks: agg.sacks,
    }))
    .sort((a, b) => b.kg - a.kg);

  // `rows` is already newest-first, so the head IS the recent list.
  const recent: RcInRecentRow[] = rows.slice(0, RECENT_ROWS).map((r) => ({
    id: r.id,
    date: r.transaction_date ?? "",
    supplier: (r.supplier ?? "").trim() || "—",
    truckPlate: r.truck_plate,
    sacks: r.sacks == null ? null : n(r.sacks),
    weightKg: round(n(r.weight_kg)),
  }));

  return {
    kind: "rc_in",
    range,
    granularity,
    startDate,
    endDate,
    series,
    summary: {
      totalKg: round(totalKg),
      avgPerActiveBucket:
        active.length > 0
          ? round(active.reduce((a, p) => a + p.kg, 0) / active.length)
          : null,
      peak: peakPoint
        ? { bucket: peakPoint.bucket, label: peakPoint.label, kg: peakPoint.kg }
        : null,
      activeBuckets: active.length,
      deliveryCount: rows.length,
      supplierCount: suppliers.length,
    },
    suppliers,
    recent,
    truncated,
  };
}

// =====================================================================
// RC In price (₱/kg) — price-gated
// =====================================================================

interface DailyPriceRow {
  date: string;
  php_per_kg: number | string | null;
}

interface MonthlyAnalyticsRow {
  year: number | null;
  month: number | null;
  avg_price: number | string | null;
}

/** The market-purchase caveat attached to the MONTHLY series. The daily price
 *  view is built on `view_supplier_deliveries` (priced, non-sundry); the
 *  monthly analytics view additionally drops refeed/recook re-processing. Both
 *  are "market price", but they are not the SAME set — so the modal says which
 *  one it is showing rather than presenting two definitions as one number. */
const MONTHLY_POPULATION_NOTE =
  "Monthly figures are the weighted average of market purchases only — sundry, refeed and recook re-processing are excluded.";

function emptyPriceDrilldown(
  range: DrilldownRange,
  startDate: string,
  endDate: string,
  granularity: DrilldownGranularity,
  restricted: boolean,
  populationNote: string | null
): PriceDrilldown {
  return {
    kind: "rc_in_price",
    range,
    granularity,
    startDate,
    endDate,
    restricted,
    series: [],
    summary: {
      minPhp: null,
      maxPhp: null,
      meanPhp: null,
      latestPhp: null,
      biggestSwing: null,
    },
    populationNote,
  };
}

export async function getRcInPriceDrilldown(
  range: DrilldownRange
): Promise<PriceDrilldown> {
  const supabase = await createClient();

  // The gate runs FIRST and concurrently with nothing — a denied role must not
  // even cause a ₱ to be read, let alone shaped into a response.
  const [showPrices, operationalDate] = await Promise.all([
    canViewPrices(),
    resolveOperationalDate(supabase),
  ]);
  const { startDate, endDate, granularity } = resolveWindow(
    range,
    operationalDate
  );

  if (!showPrices) {
    return emptyPriceDrilldown(
      range,
      startDate,
      endDate,
      granularity,
      true,
      null
    );
  }

  let points: Array<{ bucket: string; label: string; phpPerKg: number | null }>;

  if (granularity === "month") {
    // Windowed by construction: one row per (year, month) of ONE year.
    const { data, error } = await supabase
      .from("view_delivery_monthly_analytics")
      .select("year, month, avg_price")
      .eq("year", Number(endDate.slice(0, 4)))
      .order("month", { ascending: true });
    if (error) {
      throw new Error(`RC In price drill-down query failed: ${error.message}`);
    }
    const rows = (data as MonthlyAnalyticsRow[] | null) ?? [];
    const byBucket = new Map<string, number | null>();
    for (const r of rows) {
      if (r.year == null || r.month == null) continue;
      const bucket = `${r.year}-${String(r.month).padStart(2, "0")}`;
      // avg_price is NULL when the month had no PRICED purchase. Keep it null —
      // 0 is the L-008 unpriced placeholder, never a price.
      byBucket.set(bucket, r.avg_price == null ? null : round(n(r.avg_price)));
    }
    points = monthBuckets(startDate, endDate).map((bucket) => ({
      bucket,
      label: monthLabel(bucket),
      phpPerKg: byBucket.get(bucket) ?? null,
    }));
  } else {
    // `view_digest_daily_price` is windowed to a trailing 120 days in SQL and
    // emits ONLY days with a real market purchase — so the axis is the reported
    // days, with no zero-fill (a zero would read as a ₱0 price).
    const { data, error } = await supabase
      .from("view_digest_daily_price")
      .select("date, php_per_kg")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true });
    if (error) {
      throw new Error(`RC In price drill-down query failed: ${error.message}`);
    }
    const rows = (data as DailyPriceRow[] | null) ?? [];
    points = rows.map((r) => ({
      bucket: r.date,
      label: dayLabel(r.date),
      phpPerKg: r.php_per_kg == null ? null : round(n(r.php_per_kg)),
    }));
  }

  // Bucket-over-bucket % change. Pure display math over an already-correct
  // (SQL-weighted) series — the same transform the small card does inline.
  let prev: number | null = null;
  const series: PricePointDrill[] = points.map((p) => {
    const changePct =
      prev != null && prev !== 0 && p.phpPerKg != null
        ? round(((p.phpPerKg - prev) / prev) * 100, 1)
        : null;
    if (p.phpPerKg != null) prev = p.phpPerKg;
    return { ...p, changePct };
  });

  const priced = series.filter(
    (p): p is PricePointDrill & { phpPerKg: number } => p.phpPerKg != null
  );

  let biggestSwing: PriceDrilldown["summary"]["biggestSwing"] = null;
  for (const p of series) {
    if (p.changePct == null) continue;
    if (
      biggestSwing === null ||
      Math.abs(p.changePct) > Math.abs(biggestSwing.pct)
    ) {
      biggestSwing = { bucket: p.bucket, label: p.label, pct: p.changePct };
    }
  }

  return {
    kind: "rc_in_price",
    range,
    granularity,
    startDate,
    endDate,
    restricted: false,
    series,
    summary: {
      minPhp: priced.length ? Math.min(...priced.map((p) => p.phpPerKg)) : null,
      maxPhp: priced.length ? Math.max(...priced.map((p) => p.phpPerKg)) : null,
      meanPhp: priced.length
        ? round(priced.reduce((a, p) => a + p.phpPerKg, 0) / priced.length)
        : null,
      latestPhp: priced.length ? priced[priced.length - 1].phpPerKg : null,
      biggestSwing,
    },
    populationNote: granularity === "month" ? MONTHLY_POPULATION_NOTE : null,
  };
}
