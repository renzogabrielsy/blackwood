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
//     and running totals in SQL. Three things follow, and the split is
//     deliberate:
//       - the PRICE series is a weighted average, so it is read from SQL
//         at BOTH granularities (`view_digest_daily_price` /
//         `view_delivery_monthly_analytics.avg_price`) and never computed
//         here;
//       - the BY-SUPPLIER ranking is grouped in SQL by
//         `view_digest_rcin_supplier_daily`, because supplier IDENTITY is
//         a definition, not arithmetic — see the block below;
//       - RC IN's kg BUCKETS are a plain SUM of kg, rolled up in this
//         module from the range's delivery rows because the canonical
//         daily view (`view_digest_daily_flow`) is windowed to 120 days
//         and cannot reach "this year". The rollup REPRODUCES that view's
//         definition exactly (`sum(weight_kg) GROUP BY transaction_date`
//         over `deliveries`, unfiltered), so it is the same definition
//         applied to a wider window, not a second one. MEASURED
//         2026-08-28: over the 90 days to the operational date the two
//         agree on 90 of 90 days, zero mismatches. If this ever grows a
//         second consumer, promote it to a windowed SQL view instead of
//         copying the rollup.
//
//   • SUPPLIER IDENTITY LIVES IN SQL — `public.canonical_supplier(text)`
//     is the ONE definition and this module must never re-implement it.
//     Until 2026-08-28 the ranking grouped RAW `deliveries.supplier`
//     strings here, so "Ornales" (405 rows) and "ORNALES" (22 rows, June
//     2026) ranked as two suppliers and the joint-vendor misdeclares
//     ("Mercado / Ornales", "Compra/Paquibot", …) folded into nothing.
//     It now reads `view_digest_rcin_supplier_daily`, which groups by
//     `canonical_supplier(supplier)` in SQL — the same function every
//     Summaries by-supplier view uses, so the digest rail and Summaries
//     can never disagree about who a supplier is. Porting those ILIKE
//     clauses into TypeScript would create a second definition that
//     drifts the first time a spelling is added to the function.
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
  VolumePoint,
  VolumeSummary,
  RcOutDrilldown,
  RcOutBatchSlice,
  RcOutRecentRow,
  ProductionDrilldown,
  ProductionGradeSlice,
  ProductionRecentRow,
  PowerDrilldown,
  PowerMeterSlice,
  PowerRecentRow,
  FlowDrilldown,
  FlowPointDrill,
} from "@/lib/digest/drilldown-types";

/** Hard cap on either row read. YTD measured 635 delivery rows / 470 supplier-
 *  day rows (2026), and the widest full year on record is 719 / 609 (2025) —
 *  the cap is a guard against an unexpected year, not an expected boundary.
 *  Hitting it sets `truncated`, and the modal then presents every figure as a
 *  FLOOR.
 *
 *  IT IS 1000 BECAUSE POSTGREST'S OWN CAP IS 1000 (verified live: a
 *  `?limit=1500` on `deliveries` returns exactly 1000 rows). A larger constant
 *  here would make the flag INERT — the server would truncate first, the read
 *  would come back short of the cap, and the modal would report a floor as if
 *  it were a total. A truncation flag that cannot fire is worse than none. */
const ROW_CAP = 1000;

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

/** A stream's latest REPORTED day, straight from
 *  `view_digest_stream_status.through_date` — the SAME scalar the KPI card's
 *  `AsOfChip` renders, so a card and its drill-down can never disagree about
 *  which day the number belongs to.
 *
 *  Read it, never derive it: "the latest day with a row" is a ROW-SET fact and
 *  the project rule puts those in SQL (see `lib/digest/day-status.ts` — "do not
 *  reintroduce a TS scan of the daily series to find the latest day with
 *  data"). Returns null rather than guessing when the view has no row for the
 *  stream; the UI then simply omits the as-of. */
async function resolveStreamAsOf(
  supabase: Awaited<ReturnType<typeof createClient>>,
  stream: string
): Promise<string | null> {
  const { data } = await supabase
    .from("view_digest_stream_status")
    .select("through_date")
    .eq("stream", stream)
    .maybeSingle();
  return (data as { through_date: string | null } | null)?.through_date ?? null;
}

/** Zero-filled bucket axis + trailing rolling mean + the four summary figures,
 *  from a bucket→total map. ONE definition, shared by RC OUT / PRODUCTION /
 *  POWER, so their charts and stat strips cannot drift apart.
 *
 *  This is a presentational rollup of ALREADY-AGGREGATED SQL output (each
 *  source view groups in the database); nothing here re-defines what a kg, a
 *  kWh or a bucket IS. */
function buildVolumeSeries(
  totals: Map<string, number>,
  startDate: string,
  endDate: string,
  granularity: DrilldownGranularity
): { series: VolumePoint[]; summary: VolumeSummary } {
  const buckets =
    granularity === "month"
      ? monthBuckets(startDate, endDate)
      : dayBuckets(startDate, endDate);
  const values = buckets.map((b) => round(totals.get(b) ?? 0));
  const window = ROLLING_BUCKETS[granularity];

  const series: VolumePoint[] = buckets.map((bucket, i) => ({
    bucket,
    label: granularity === "month" ? monthLabel(bucket) : dayLabel(bucket),
    value: values[i],
    avg: rollingMean(values, i, window),
  }));

  const active = series.filter((p) => p.value > 0);
  const peak = active.reduce<VolumePoint | null>(
    (best, p) => (best === null || p.value > best.value ? p : best),
    null
  );

  return {
    series,
    summary: {
      total: round(active.reduce((a, p) => a + p.value, 0)),
      avgPerActiveBucket:
        active.length > 0
          ? round(active.reduce((a, p) => a + p.value, 0) / active.length)
          : null,
      peak: peak
        ? { bucket: peak.bucket, label: peak.label, value: peak.value }
        : null,
      activeBuckets: active.length,
    },
  };
}

/** Fold a (date × dimension) view read into per-bucket totals. */
function bucketOf(date: string, granularity: DrilldownGranularity): string {
  return granularity === "month" ? date.slice(0, 7) : date;
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

/** One row of `view_digest_rcin_supplier_daily` (migration 20260828032427):
 *  (transaction_date × canonical supplier), already grouped in SQL. Carries no
 *  ₱ column — kg, sacks and counts only — so this read needs no price gate. */
interface SupplierDayRow {
  transaction_date: string | null;
  supplier_canonical: string | null;
  kg: number | string | null;
  delivery_count: number | string | null;
  sack_count: number | string | null;
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

  // Two windowed, explicitly-capped reads, in parallel.
  //
  //   1. the raw delivery rows — they drive the kg BUCKETS and the recent-rows
  //      table. DESC so a truncated read keeps the MOST RECENT rows (the ones
  //      the table shows) rather than an arbitrary head.
  //   2. the supplier-day view — it drives the by-supplier RANKING, already
  //      folded to canonical supplier identity in SQL (module header).
  //
  // Neither select touches `cost_basis`, and the view has no ₱ column at all,
  // so this payload carries no price surface to gate.
  const [deliveryRes, supplierRes] = await Promise.all([
    supabase
      .from("deliveries")
      .select("id, transaction_date, supplier, truck_plate, sacks, weight_kg")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: false })
      .order("id", { ascending: false })
      .limit(ROW_CAP),
    supabase
      .from("view_digest_rcin_supplier_daily")
      .select("transaction_date, supplier_canonical, kg, delivery_count, sack_count")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .limit(ROW_CAP),
  ]);

  if (deliveryRes.error) {
    throw new Error(`RC IN drill-down query failed: ${deliveryRes.error.message}`);
  }
  if (supplierRes.error) {
    // NOT swallowed. A supplier read that fails silently would render an empty
    // rail as "no suppliers delivered", which is indistinguishable from a real
    // quiet window — the L-044 failure mode. Fail loudly instead.
    throw new Error(
      `RC IN drill-down supplier query failed: ${supplierRes.error.message}`
    );
  }

  const rows = (deliveryRes.data as DeliveryRow[] | null) ?? [];
  const supplierRows = (supplierRes.data as SupplierDayRow[] | null) ?? [];
  // EITHER read hitting the cap makes every figure below a floor.
  const truncated =
    rows.length >= ROW_CAP || supplierRows.length >= ROW_CAP;

  // ---- bucket the rows (see the module header: this reproduces
  //      view_digest_daily_flow's definition, it is not a second one) ----
  const kgByBucket = new Map<string, number>();
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
  }

  // ---- roll the per-DAY supplier rows up to per-SUPPLIER totals ----
  // Plain addition of already-grouped SQL output, the same class as the daily
  // bucketing above and as `rollingMean` — the DEFINITION (who is one supplier,
  // and what a delivery/sack/kg count is) was settled in the view. Nothing here
  // inspects a supplier string; renaming or re-folding happens only in
  // `canonical_supplier()`.
  const supplierAgg = new Map<
    string,
    { kg: number; deliveries: number; sacks: number }
  >();
  let supplierTotalKg = 0;

  for (const r of supplierRows) {
    const supplier = r.supplier_canonical ?? "UNKNOWN";
    const kg = n(r.kg);
    const agg = supplierAgg.get(supplier) ?? { kg: 0, deliveries: 0, sacks: 0 };
    agg.kg += kg;
    agg.deliveries += n(r.delivery_count);
    agg.sacks += n(r.sack_count);
    supplierAgg.set(supplier, agg);
    supplierTotalKg += kg;
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

  // `supplier` is rendered exactly as SQL returns it — `canonical_supplier()`
  // emits UPPER, and every other supplier surface in the app shows that same
  // casing. Title-casing it here would be a second presentation rule with
  // nothing to keep it in step.
  //
  // The share is taken against the SUPPLIER read's own total, not the raw
  // delivery read's: the two totals are equal by construction (both are
  // unfiltered sums of `weight_kg` over the same range — measured 0.00 kg apart
  // across the whole 121-day flow window on 2026-08-28), but if one read were
  // ever truncated and the other not, dividing across them would print shares
  // that do not sum to 100%.
  const suppliers: RcInSupplierSlice[] = Array.from(supplierAgg.entries())
    .map(([supplier, agg]) => ({
      supplier,
      kg: round(agg.kg),
      sharePct:
        supplierTotalKg > 0 ? round((agg.kg / supplierTotalKg) * 100, 1) : 0,
      deliveries: agg.deliveries,
      sacks: agg.sacks,
    }))
    .sort((a, b) => b.kg - a.kg);

  // `rows` is already newest-first, so the head IS the recent list.
  //
  // These deliberately show the RAW STORED SPELLING of `supplier`, not the
  // canonical name the rail ranks by. This table is the underlying RECORDS —
  // what is actually in the row someone would open in RC IN — so showing a
  // folded name here would misreport the data. The rail answers "who supplied
  // us"; this answers "what does the row say". Do not "fix" the mismatch.
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

// =====================================================================
// RC OUT — kg fed
// =====================================================================

/** One row of `view_digest_rcout_batch_daily` (migration 20260828074001):
 *  (transaction_date × batch_code × block_loc × destination) → kg + feedings.
 *  Carries no ₱ column, so this read needs no price gate. */
interface RcOutBatchDayRow {
  transaction_date: string | null;
  batch_code: string | null;
  block_loc: string | null;
  destination: string | null;
  kg: number | string | null;
  feeding_count: number | string | null;
}

/** The `rc_out` rows behind the "recent feedings" table. `batches` is the
 *  embedded parent — PostgREST returns it as an object (or, defensively, a
 *  one-element array), which is why it is flattened below rather than typed as
 *  a single shape. */
interface RcOutRecentQueryRow {
  id: string;
  transaction_date: string | null;
  block_loc: string | null;
  destination: string | null;
  weight_kg: number | string | null;
  batches: { batch_code: string | null } | { batch_code: string | null }[] | null;
}

/** The destination that means "the plant" and therefore says nothing when
 *  printed. Compared case-insensitively; anything else (a SUNDRY move) IS
 *  worth showing, which is the only reason `destination` is carried at all. */
const DEFAULT_DESTINATION = "MAIN";

export async function getRcOutDrilldown(
  range: DrilldownRange
): Promise<RcOutDrilldown> {
  const supabase = await createClient();
  const operationalDate = await resolveOperationalDate(supabase);
  const { startDate, endDate, granularity } = resolveWindow(
    range,
    operationalDate
  );

  // Three reads in parallel:
  //   1. the batch-day view — it drives BOTH the kg series and the by-batch
  //      ranking. Ordered DESC so a capped read keeps the MOST RECENT buckets:
  //      the right-hand edge of the chart is where the reader is looking, and
  //      the truncation banner says outright that the figures are a floor.
  //   2. the last few underlying `rc_out` rows, with the batch code joined in.
  //   3. the stream's latest reported day, for the as-of in the header.
  const [viewRes, recentRes, asOf] = await Promise.all([
    supabase
      .from("view_digest_rcout_batch_daily")
      .select("transaction_date, batch_code, block_loc, destination, kg, feeding_count")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: false })
      .limit(ROW_CAP),
    supabase
      .from("rc_out")
      .select("id, transaction_date, block_loc, destination, weight_kg, batches(batch_code)")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: false })
      .order("id", { ascending: false })
      .limit(RECENT_ROWS),
    resolveStreamAsOf(supabase, "rc_out"),
  ]);

  if (viewRes.error) {
    throw new Error(`RC OUT drill-down query failed: ${viewRes.error.message}`);
  }
  if (recentRes.error) {
    // NOT swallowed — an empty table rendered as "no feedings" is
    // indistinguishable from a genuinely quiet window (the L-044 failure mode).
    throw new Error(
      `RC OUT drill-down recent-rows query failed: ${recentRes.error.message}`
    );
  }

  const rows = (viewRes.data as RcOutBatchDayRow[] | null) ?? [];
  // THE CAP GENUINELY BITES HERE. This grain runs ~4.2 rows per operating day
  // (1,255 rows / 400 days, 830 for 2026 YTD), so a late-in-year "This year"
  // read can reach PostgREST's own 1000-row ceiling. Never raise ROW_CAP to
  // "fix" it — the server truncates at 1000 first, and the flag would go inert.
  const truncated = rows.length >= ROW_CAP;

  const kgByBucket = new Map<string, number>();
  const byBatch = new Map<
    string,
    {
      kg: number;
      feedings: number;
      /** block → kg, so the rail can name the HEAVIEST block rather than an
       *  arbitrary one, and say how many blocks a batch was fed from. */
      blocks: Map<string, number>;
      destinations: Set<string>;
    }
  >();
  let totalKg = 0;
  let feedingCount = 0;

  for (const r of rows) {
    if (!r.transaction_date) continue;
    const kg = n(r.kg);
    const bucket = bucketOf(r.transaction_date, granularity);
    kgByBucket.set(bucket, (kgByBucket.get(bucket) ?? 0) + kg);
    totalKg += kg;
    feedingCount += n(r.feeding_count);

    const code = (r.batch_code ?? "").trim() || "—";
    const agg =
      byBatch.get(code) ??
      { kg: 0, feedings: 0, blocks: new Map<string, number>(), destinations: new Set<string>() };
    agg.kg += kg;
    agg.feedings += n(r.feeding_count);
    // block_loc is NULL when rc_out stored a BLANK — "unrecorded", not "".
    if (r.block_loc) {
      agg.blocks.set(r.block_loc, (agg.blocks.get(r.block_loc) ?? 0) + kg);
    }
    if (r.destination) agg.destinations.add(r.destination);
    byBatch.set(code, agg);
  }

  const { series, summary } = buildVolumeSeries(
    kgByBucket,
    startDate,
    endDate,
    granularity
  );

  const batches: RcOutBatchSlice[] = Array.from(byBatch.entries())
    .map(([batchCode, agg]) => {
      const heaviestBlock = Array.from(agg.blocks.entries()).sort(
        (a, b) => b[1] - a[1]
      )[0];
      return {
        batchCode,
        blockLoc: heaviestBlock?.[0] ?? null,
        blockCount: agg.blocks.size,
        otherDestinations: Array.from(agg.destinations)
          .filter((d) => d.trim().toUpperCase() !== DEFAULT_DESTINATION)
          .sort(),
        kg: round(agg.kg),
        sharePct: totalKg > 0 ? round((agg.kg / totalKg) * 100, 1) : 0,
        feedings: agg.feedings,
      };
    })
    .sort((a, b) => b.kg - a.kg);

  const recent: RcOutRecentRow[] = (
    (recentRes.data as RcOutRecentQueryRow[] | null) ?? []
  ).map((r) => {
    const parent = Array.isArray(r.batches) ? r.batches[0] : r.batches;
    return {
      id: r.id,
      date: r.transaction_date ?? "",
      batchCode: (parent?.batch_code ?? "").trim() || "—",
      blockLoc: r.block_loc?.trim() ? r.block_loc : null,
      destination: (r.destination ?? "").trim() || "—",
      weightKg: round(n(r.weight_kg)),
    };
  });

  return {
    kind: "rc_out",
    range,
    granularity,
    startDate,
    endDate,
    asOf,
    series,
    summary: { ...summary, feedingCount, batchCount: batches.length },
    batches,
    recent,
    truncated,
  };
}

// =====================================================================
// PRODUCTION — kg produced
// =====================================================================

/** One row of `view_digest_production_grade_daily` (migration 20260828074001):
 *  (transaction_date × grade) → kg, run_count, shift_count, sacks,
 *  runs_with_sacks. `sacks` is NULLABLE and never 0-filled. */
interface ProductionGradeDayRow {
  transaction_date: string | null;
  grade: string | null;
  kg: number | string | null;
  run_count: number | string | null;
  sacks: number | string | null;
  runs_with_sacks: number | string | null;
}

/** The recent runs are read from the SHIFT side, not the run side: a run's
 *  date lives on its parent, and PostgREST cannot ORDER a parent read by an
 *  embedded column. Ordering the shifts and flattening their runs gets a real
 *  newest-first list; ordering runs by an embedded date would not. */
interface ProductionShiftQueryRow {
  id: string;
  transaction_date: string | null;
  shift: string | null;
  production_runs:
    | {
        id: string;
        grade: string | null;
        ttl_kg: number | string | null;
        sacks_bags: number | string | null;
      }[]
    | null;
}

/** Shifts pulled for the recent-runs list. Each shift carries 1–3 runs, so a
 *  dozen shifts comfortably covers RECENT_ROWS runs without a second query. */
const RECENT_SHIFTS = 12;

export async function getProductionDrilldown(
  range: DrilldownRange
): Promise<ProductionDrilldown> {
  const supabase = await createClient();
  const operationalDate = await resolveOperationalDate(supabase);
  const { startDate, endDate, granularity } = resolveWindow(
    range,
    operationalDate
  );

  const [viewRes, shiftRes, asOf] = await Promise.all([
    supabase
      .from("view_digest_production_grade_daily")
      .select("transaction_date, grade, kg, run_count, sacks, runs_with_sacks")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: false })
      .limit(ROW_CAP),
    supabase
      .from("production_shifts")
      .select("id, transaction_date, shift, production_runs(id, grade, ttl_kg, sacks_bags)")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(RECENT_SHIFTS),
    resolveStreamAsOf(supabase, "production"),
  ]);

  if (viewRes.error) {
    throw new Error(
      `Production drill-down query failed: ${viewRes.error.message}`
    );
  }
  if (shiftRes.error) {
    throw new Error(
      `Production drill-down recent-runs query failed: ${shiftRes.error.message}`
    );
  }

  const rows = (viewRes.data as ProductionGradeDayRow[] | null) ?? [];
  const truncated = rows.length >= ROW_CAP;

  const kgByBucket = new Map<string, number>();
  const byGrade = new Map<
    string,
    { kg: number; runs: number; sacks: number; runsWithSacks: number }
  >();
  let totalKg = 0;
  let runCount = 0;
  let totalSacks = 0;
  let totalRunsWithSacks = 0;

  for (const r of rows) {
    if (!r.transaction_date) continue;
    const kg = n(r.kg);
    const bucket = bucketOf(r.transaction_date, granularity);
    kgByBucket.set(bucket, (kgByBucket.get(bucket) ?? 0) + kg);
    totalKg += kg;
    runCount += n(r.run_count);
    // `sacks` is NULL when no run of that grade/day recorded one. n() folds
    // null to 0 for the SUM, which is correct arithmetic — the honesty lives in
    // `runsWithSacks`, which is what decides whether a total is shown at all.
    totalSacks += n(r.sacks);
    totalRunsWithSacks += n(r.runs_with_sacks);

    const grade = (r.grade ?? "").trim() || "—";
    const agg =
      byGrade.get(grade) ?? { kg: 0, runs: 0, sacks: 0, runsWithSacks: 0 };
    agg.kg += kg;
    agg.runs += n(r.run_count);
    agg.sacks += n(r.sacks);
    agg.runsWithSacks += n(r.runs_with_sacks);
    byGrade.set(grade, agg);
  }

  const { series, summary } = buildVolumeSeries(
    kgByBucket,
    startDate,
    endDate,
    granularity
  );

  const grades: ProductionGradeSlice[] = Array.from(byGrade.entries())
    .map(([grade, agg]) => ({
      grade,
      kg: round(agg.kg),
      sharePct: totalKg > 0 ? round((agg.kg / totalKg) * 100, 1) : 0,
      runs: agg.runs,
      // NULL, not 0, when nothing was ever recorded — "not recorded" and
      // "zero bags" are different facts and the UI says so.
      sacks: agg.runsWithSacks > 0 ? agg.sacks : null,
      runsWithSacks: agg.runsWithSacks,
    }))
    .sort((a, b) => b.kg - a.kg);

  const recent: ProductionRecentRow[] = (
    (shiftRes.data as ProductionShiftQueryRow[] | null) ?? []
  )
    .flatMap((s) =>
      (s.production_runs ?? []).map((run) => ({
        id: run.id,
        date: s.transaction_date ?? "",
        shift: s.shift?.trim() ? s.shift : null,
        grade: (run.grade ?? "").trim() || "—",
        kg: round(n(run.ttl_kg)),
        sacks: run.sacks_bags == null ? null : n(run.sacks_bags),
      }))
    )
    .slice(0, RECENT_ROWS);

  return {
    kind: "production",
    range,
    granularity,
    startDate,
    endDate,
    asOf,
    series,
    summary: {
      ...summary,
      runCount,
      gradeCount: grades.length,
      sacks: totalRunsWithSacks > 0 ? totalSacks : null,
      runsWithSacks: totalRunsWithSacks,
    },
    grades,
    recent,
    truncated,
  };
}

// =====================================================================
// FLOW — received vs fed, and the net between them
// =====================================================================
// ONE fetcher behind BOTH the NET FLOW tile and the Feed In vs Out card. No
// view backs it: it is RC IN daily minus RC OUT daily, from the two breakdown
// views summed per day. Measured against `view_digest_daily_flow` over its
// whole 121-day window — in 121/121, out 121/121, net 121/121.
//
// Deriving it here rather than reading `view_digest_daily_flow` is the same
// trade the RC IN buckets make: that view is windowed to 120 days in SQL and
// cannot reach "this year". Same definition, wider window — not a second one.

interface FlowInRow {
  transaction_date: string | null;
  kg: number | string | null;
}

export async function getFlowDrilldown(
  range: DrilldownRange
): Promise<FlowDrilldown> {
  const supabase = await createClient();
  const operationalDate = await resolveOperationalDate(supabase);
  const { startDate, endDate, granularity } = resolveWindow(
    range,
    operationalDate
  );

  // Neither view carries a ₱ column, so this payload has no price surface.
  const [inRes, outRes] = await Promise.all([
    supabase
      .from("view_digest_rcin_supplier_daily")
      .select("transaction_date, kg")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: false })
      .limit(ROW_CAP),
    supabase
      .from("view_digest_rcout_batch_daily")
      .select("transaction_date, kg")
      .gte("transaction_date", startDate)
      .lte("transaction_date", endDate)
      .order("transaction_date", { ascending: false })
      .limit(ROW_CAP),
  ]);

  if (inRes.error) {
    throw new Error(`Flow drill-down RC IN query failed: ${inRes.error.message}`);
  }
  if (outRes.error) {
    throw new Error(
      `Flow drill-down RC OUT query failed: ${outRes.error.message}`
    );
  }

  const inRows = (inRes.data as FlowInRow[] | null) ?? [];
  const outRows = (outRes.data as FlowInRow[] | null) ?? [];
  // EITHER side hitting the cap makes the NET a floor too — and worse than a
  // floor, a net computed from one truncated side and one complete side would
  // be actively wrong. So the flag covers both and the modal says so.
  const truncated = inRows.length >= ROW_CAP || outRows.length >= ROW_CAP;

  const inByBucket = new Map<string, number>();
  const outByBucket = new Map<string, number>();
  let inKg = 0;
  let outKg = 0;

  for (const r of inRows) {
    if (!r.transaction_date) continue;
    const kg = n(r.kg);
    const bucket = bucketOf(r.transaction_date, granularity);
    inByBucket.set(bucket, (inByBucket.get(bucket) ?? 0) + kg);
    inKg += kg;
  }
  for (const r of outRows) {
    if (!r.transaction_date) continue;
    const kg = n(r.kg);
    const bucket = bucketOf(r.transaction_date, granularity);
    outByBucket.set(bucket, (outByBucket.get(bucket) ?? 0) + kg);
    outKg += kg;
  }

  const buckets =
    granularity === "month"
      ? monthBuckets(startDate, endDate)
      : dayBuckets(startDate, endDate);

  const series: FlowPointDrill[] = buckets.map((bucket) => {
    const bIn = round(inByBucket.get(bucket) ?? 0);
    const bOut = round(outByBucket.get(bucket) ?? 0);
    return {
      bucket,
      label: granularity === "month" ? monthLabel(bucket) : dayLabel(bucket),
      inKg: bIn,
      outKg: bOut,
      netKg: round(bIn - bOut),
    };
  });

  // "Active" = either side moved. A bucket where NOTHING happened is not a
  // zero-net day worth averaging in — it is a day the plant was closed.
  const active = series.filter((p) => p.inKg > 0 || p.outKg > 0);

  let biggestSurplus: FlowDrilldown["summary"]["biggestSurplus"] = null;
  let biggestDeficit: FlowDrilldown["summary"]["biggestDeficit"] = null;
  for (const p of active) {
    if (p.netKg > 0 && (biggestSurplus === null || p.netKg > biggestSurplus.netKg)) {
      biggestSurplus = { bucket: p.bucket, label: p.label, netKg: p.netKg };
    }
    if (p.netKg < 0 && (biggestDeficit === null || p.netKg < biggestDeficit.netKg)) {
      biggestDeficit = { bucket: p.bucket, label: p.label, netKg: p.netKg };
    }
  }

  return {
    kind: "flow",
    range,
    granularity,
    startDate,
    endDate,
    series,
    summary: {
      inKg: round(inKg),
      outKg: round(outKg),
      netKg: round(inKg - outKg),
      avgNetPerBucket:
        active.length > 0
          ? round(active.reduce((a, p) => a + p.netKg, 0) / active.length)
          : null,
      biggestSurplus,
      biggestDeficit,
      activeBuckets: active.length,
    },
    truncated,
  };
}

// =====================================================================
// POWER — kWh consumed
// =====================================================================

/** One row of `view_digest_power_meter_daily` (migration 20260828074001):
 *  (reading_date × meter) → kwh. `kwh` is `sum(consumption_kwh)`, the exact
 *  column the POWER tile sums, so the modal total always equals the tile. */
interface PowerMeterDayRow {
  reading_date: string | null;
  meter: string | null;
  kwh: number | string | null;
  reading_count: number | string | null;
}

interface PowerReadingQueryRow {
  id: string;
  reading_date: string | null;
  meter: string | null;
  consumption_kwh: number | string | null;
}

export async function getPowerDrilldown(
  range: DrilldownRange
): Promise<PowerDrilldown> {
  const supabase = await createClient();
  const operationalDate = await resolveOperationalDate(supabase);
  const { startDate, endDate, granularity } = resolveWindow(
    range,
    operationalDate
  );

  const [viewRes, recentRes, asOf] = await Promise.all([
    supabase
      .from("view_digest_power_meter_daily")
      .select("reading_date, meter, kwh, reading_count")
      .gte("reading_date", startDate)
      .lte("reading_date", endDate)
      .order("reading_date", { ascending: false })
      .limit(ROW_CAP),
    supabase
      .from("electricity_readings")
      .select("id, reading_date, meter, consumption_kwh")
      .gte("reading_date", startDate)
      .lte("reading_date", endDate)
      .order("reading_date", { ascending: false })
      .order("meter", { ascending: true })
      .limit(RECENT_ROWS),
    resolveStreamAsOf(supabase, "electricity"),
  ]);

  if (viewRes.error) {
    throw new Error(`Power drill-down query failed: ${viewRes.error.message}`);
  }
  if (recentRes.error) {
    throw new Error(
      `Power drill-down recent-readings query failed: ${recentRes.error.message}`
    );
  }

  const rows = (viewRes.data as PowerMeterDayRow[] | null) ?? [];
  const truncated = rows.length >= ROW_CAP;

  const kwhByBucket = new Map<string, number>();
  const byMeter = new Map<string, { kwh: number; readings: number }>();
  let totalKwh = 0;
  let readingCount = 0;

  for (const r of rows) {
    if (!r.reading_date) continue;
    const kwh = n(r.kwh);
    const bucket = bucketOf(r.reading_date, granularity);
    kwhByBucket.set(bucket, (kwhByBucket.get(bucket) ?? 0) + kwh);
    totalKwh += kwh;
    readingCount += n(r.reading_count);

    const meter = (r.meter ?? "").trim() || "—";
    const agg = byMeter.get(meter) ?? { kwh: 0, readings: 0 };
    agg.kwh += kwh;
    agg.readings += n(r.reading_count);
    byMeter.set(meter, agg);
  }

  const { series, summary } = buildVolumeSeries(
    kwhByBucket,
    startDate,
    endDate,
    granularity
  );

  // A ONE-ENTRY RAIL IS CORRECT DATA HERE, not an empty state: BUNKHOUSE and
  // PUMP were last reported 2025-12-12, so any 30d/90d window legitimately
  // contains MAIN alone. The UI renders whatever this returns, plainly.
  const meters: PowerMeterSlice[] = Array.from(byMeter.entries())
    .map(([meter, agg]) => ({
      meter,
      kwh: round(agg.kwh),
      sharePct: totalKwh > 0 ? round((agg.kwh / totalKwh) * 100, 1) : 0,
      readings: agg.readings,
    }))
    .sort((a, b) => b.kwh - a.kwh);

  const recent: PowerRecentRow[] = (
    (recentRes.data as PowerReadingQueryRow[] | null) ?? []
  ).map((r) => ({
    id: r.id,
    date: r.reading_date ?? "",
    meter: (r.meter ?? "").trim() || "—",
    // consumption_kwh is nullable in the source table — kept null, never 0.
    kwh: r.consumption_kwh == null ? null : round(n(r.consumption_kwh)),
  }));

  return {
    kind: "power",
    range,
    granularity,
    startDate,
    endDate,
    asOf,
    series,
    summary: { ...summary, readingCount, meterCount: meters.length },
    meters,
    recent,
    truncated,
  };
}
